/** A node-postgres `Client` or pool client (anything with `query`). */
export interface PgQueryable {
	query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** A node-postgres `Pool`: a client is checked out for the clean's transaction. */
export interface PgPoolLike extends PgQueryable {
	totalCount: number;
	connect(): Promise<PgQueryable & { release(err?: boolean | Error): void }>;
}

export interface CleanDatabaseOptions {
	/** Default `["public"]`. */
	schemas?: string[];
	/** Tables to keep, as `name` or `schema.name`. Migration tables are always kept. */
	exclude?: string[];
}

interface Target {
	qualified: string;
	sequences: string[];
}

const MIGRATION_TABLES = ["__drizzle_migrations", "_prisma_migrations"];
const RETRY_BACKOFF_MS = [50, 150, 450, 1000, 2000, 4000];

const targetsCache = new Map<unknown, Map<string, Promise<Target[]>>>();

const TARGETS_SQL = `
	select format('%I.%I', n.nspname, c.relname) as qualified,
		array_remove(array_agg(distinct case when s.oid is not null
			then format('%I.%I', sn.nspname, s.relname) end), null) as sequences
	from pg_class c
	join pg_namespace n on n.oid = c.relnamespace
	left join pg_depend d on d.refobjid = c.oid and d.classid = 'pg_class'::regclass
		and d.deptype in ('a', 'i')
	left join pg_class s on s.oid = d.objid and s.relkind = 'S'
	left join pg_namespace sn on sn.oid = s.relnamespace
	where c.relkind in ('r', 'p') and not c.relispartition
		and n.nspname = any($1::text[])
		and c.relname <> all($2::text[])
		and (n.nspname || '.' || c.relname) <> all($2::text[])
	group by n.nspname, c.relname
	order by 1`;

function pgCode(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	const direct = (err as { code?: string }).code;
	if (direct) return direct;
	const cause = (err as { cause?: { code?: string } }).cause;
	return cause && typeof cause === "object" ? cause.code : undefined;
}

async function withConnection<T>(
	target: string | PgQueryable | PgPoolLike,
	fn: (c: PgQueryable) => Promise<T>,
): Promise<T> {
	if (typeof target === "string") {
		const { default: pg } = await import("pg");
		const client = new pg.Client({ connectionString: target });
		await client.connect();
		try {
			return await fn(client);
		} finally {
			await client.end();
		}
	}
	if ("totalCount" in target) {
		const client = await target.connect();
		try {
			return await fn(client);
		} finally {
			client.release();
		}
	}
	return fn(target);
}

/**
 * Empties every table that holds rows (in `schemas`, minus `exclude`) and restarts their
 * owned sequences: one EXISTS probe, then a DELETE per dirty table with FK triggers off
 * (`session_replication_role = replica`, which needs a superuser). Far cheaper than a
 * TRUNCATE of every table when a test touched a few. The table list is read once per
 * `target` and options; tables created later are not seen.
 *
 * A lock wait aborts after 2s and a deadlock is retried with backoff (about 8s at most),
 * for fire-and-forget work still holding row locks.
 */
export async function cleanDatabase(
	target: string | PgQueryable | PgPoolLike,
	options: CleanDatabaseOptions = {},
): Promise<void> {
	const schemas = options.schemas ?? ["public"];
	const exclude = [...MIGRATION_TABLES, ...(options.exclude ?? [])];
	const key = JSON.stringify([schemas, exclude]);
	const byOptions = targetsCache.get(target) ?? new Map<string, Promise<Target[]>>();
	targetsCache.set(target, byOptions);
	let targets = byOptions.get(key);
	if (!targets) {
		targets = withConnection(target, async (c) => {
			const { rows } = await c.query(TARGETS_SQL, [schemas, exclude]);
			return (rows as { qualified: string; sequences: string[] | null }[]).map((r) => ({
				qualified: r.qualified,
				sequences: r.sequences ?? [],
			}));
		});
		byOptions.set(key, targets);
		targets.catch(() => byOptions.delete(key));
	}
	const list = await targets;
	if (list.length === 0) return;
	const probe = list
		.map((t, i) => `select ${i} as i where exists (select 1 from ${t.qualified})`)
		.join(" union all ");

	for (let attempt = 0; ; attempt++) {
		try {
			await withConnection(target, async (c) => {
				await c.query("begin");
				try {
					await c.query("set local lock_timeout = '2s'");
					// rows go in any order, so FK triggers are off for this transaction only
					await c.query("set local session_replication_role = replica");
					const { rows } = await c.query(probe);
					for (const { i } of rows as { i: number }[]) {
						const t = list[Number(i)];
						if (!t) continue;
						await c.query(`delete from ${t.qualified}`);
						for (const seq of t.sequences) await c.query(`alter sequence ${seq} restart`);
					}
					await c.query("commit");
				} catch (err) {
					await c.query("rollback").catch(() => {});
					throw err;
				}
			});
			return;
		} catch (err) {
			const code = pgCode(err);
			if (code === "42501") {
				throw new Error(
					"cleanDatabase needs a superuser (or GRANT SET ON PARAMETER session_replication_role) to turn FK triggers off",
					{ cause: err },
				);
			}
			const backoff = RETRY_BACKOFF_MS[attempt];
			if ((code === "40P01" || code === "55P03") && backoff !== undefined) {
				await new Promise((r) => setTimeout(r, backoff));
				continue;
			}
			throw err;
		}
	}
}
