import type { CacheStore } from "./store.ts";

/** Anything with pg's `query`: a `pg.Pool` (preferred) or a client. */
interface Queryable {
	query(
		text: string,
		values?: unknown[],
	): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

// its own schema: ORM migrations and the test reset look at "public" and never see it
const TABLE = "tatara.cache";
const EXPIRES =
	"case when $3::bigint is null then null else now() + $3::bigint * interval '1 millisecond' end";
const LIVE = "(expires_at is null or expires_at > now())";

/** A Postgres store: an unlogged table, so writes skip the WAL and a crash empties it. */
export function postgresStore(db: Queryable): CacheStore {
	let ready: Promise<void> | undefined;
	const ensure = () => {
		ready ??= (async () => {
			try {
				await db.query("create schema if not exists tatara");
				await db.query(
					`create unlogged table if not exists ${TABLE} (key text primary key, value text not null, expires_at timestamptz)`,
				);
			} catch (error) {
				// another process created it first: "if not exists" still races on the catalog
				if (!["23505", "42P06", "42P07"].includes((error as { code?: string }).code ?? "")) {
					ready = undefined;
					throw error;
				}
			}
		})();
		return ready;
	};
	const query = async (text: string, values: unknown[]) => {
		await ensure();
		return db.query(text, values);
	};
	let writes = 0;
	const sweep = async () => {
		if (++writes % 1000 === 0) await query(`delete from ${TABLE} where expires_at <= now()`, []);
	};

	return {
		async get(key) {
			const { rows } = await query(`select value from ${TABLE} where key = $1 and ${LIVE}`, [key]);
			return (rows[0]?.value as string | undefined) ?? null;
		},
		async set(key, value, ttlMs) {
			await sweep();
			await query(
				`insert into ${TABLE} (key, value, expires_at) values ($1, $2, ${EXPIRES})
				 on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`,
				[key, value, ttlMs ?? null],
			);
		},
		async add(key, value, ttlMs) {
			await sweep();
			const { rowCount } = await query(
				`insert into ${TABLE} (key, value, expires_at) values ($1, $2, ${EXPIRES})
				 on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
				 where ${TABLE}.expires_at <= now()`,
				[key, value, ttlMs ?? null],
			);
			return rowCount === 1;
		},
		async take(key) {
			const { rows } = await query(
				`delete from ${TABLE} where key = $1 returning value, ${LIVE} as live`,
				[key],
			);
			return rows[0]?.live ? (rows[0].value as string) : null;
		},
		async del(keys) {
			await query(`delete from ${TABLE} where key = any($1)`, [keys]);
		},
		async delIfEquals(key, value) {
			const { rowCount } = await query(
				`delete from ${TABLE} where key = $1 and value = $2 and ${LIVE}`,
				[key, value],
			);
			return rowCount === 1;
		},
		async extendIfEquals(key, value, ttlMs) {
			const { rowCount } = await query(
				`update ${TABLE} set expires_at = ${EXPIRES} where key = $1 and value = $2 and ${LIVE}`,
				[key, value, ttlMs],
			);
			return rowCount === 1;
		},
		async delPrefix(prefix) {
			const pattern = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
			const { rowCount } = await query(
				`delete from ${TABLE} where key like $1 escape '\\' and ${LIVE}`,
				[pattern],
			);
			return rowCount ?? 0;
		},
		async increment(key, by, ttlMs) {
			// rate limits only increment: without this, one row per caller would stay forever
			await sweep();
			const expired = `${TABLE}.expires_at <= now()`;
			const { rows } = await query(
				`insert into ${TABLE} (key, value, expires_at) values ($1, $2::bigint::text, ${EXPIRES})
				 on conflict (key) do update set
				   value = ((case when ${expired} then 0 else ${TABLE}.value::bigint end) + $2::bigint)::text,
				   expires_at = case when ${expired} then excluded.expires_at
				                     else coalesce(${TABLE}.expires_at, excluded.expires_at) end
				 returning value`,
				[key, by, ttlMs ?? null],
			);
			return Number(rows[0]?.value);
		},
	};
}
