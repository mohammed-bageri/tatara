import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { drizzleMigrationStatus, type MigrationStatusReport } from "./migration-status.ts";

/** Applies ./drizzle migrations to the database at `url`. */
export async function migrateDatabase(url: string): Promise<void> {
	const connection = await mysql.createConnection({ uri: url });
	try {
		await migrate(drizzle({ client: connection }), { migrationsFolder: "drizzle" });
	} finally {
		await connection.end();
	}
}

/** The migrations Drizzle recorded in `__drizzle_migrations`; none when the table does not exist yet. */
export async function appliedMigrations(
	url: string,
): Promise<{ hash: string; createdAt: number }[]> {
	const connection = await mysql.createConnection({ uri: url });
	try {
		const [tables] = await connection.query(
			"select 1 from information_schema.tables where table_schema = database() and table_name = '__drizzle_migrations'",
		);
		if ((tables as unknown[]).length === 0) return [];
		const [rows] = await connection.query(
			"select hash, created_at from __drizzle_migrations order by created_at",
		);
		return (rows as { hash: string; created_at: string | number }[]).map((r) => ({
			hash: r.hash,
			createdAt: Number(r.created_at),
		}));
	} finally {
		await connection.end();
	}
}

/** Applied vs pending for every migration in ./drizzle (the folder `migrateDatabase` applies); read-only. */
export async function migrationStatus(url: string): Promise<MigrationStatusReport> {
	return drizzleMigrationStatus("drizzle", await appliedMigrations(url));
}
