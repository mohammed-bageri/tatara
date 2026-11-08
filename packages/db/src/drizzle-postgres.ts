import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Applies ./drizzle migrations to the database at `url`. */
export async function migrateDatabase(url: string): Promise<void> {
	const pool = new pg.Pool({ connectionString: url, max: 1 });
	try {
		await migrate(drizzle({ client: pool }), { migrationsFolder: "drizzle" });
	} finally {
		await pool.end();
	}
}

/** The migrations Drizzle recorded in `drizzle.__drizzle_migrations`; none when the table does not exist yet. */
export async function appliedMigrations(
	url: string,
): Promise<{ hash: string; createdAt: number }[]> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const exists = await client.query<{ found: boolean }>(
			"select to_regclass('drizzle.__drizzle_migrations') is not null as found",
		);
		if (!exists.rows[0]?.found) return [];
		const { rows } = await client.query<{ hash: string; created_at: string }>(
			"select hash, created_at from drizzle.__drizzle_migrations order by created_at",
		);
		return rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }));
	} finally {
		await client.end();
	}
}
