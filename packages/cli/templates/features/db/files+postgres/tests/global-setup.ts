import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fingerprintFiles, prepareTestDatabases } from "@tatara/testing";
import { migrateDatabase } from "#core/db/migrate";

/** Migrates `<db>_template` (again only when the migrations change) and copies it per test worker. */
export default async function setup() {
	const fileEnv = existsSync(".env.test")
		? (parseEnv(readFileSync(".env.test", "utf8")) as Record<string, string>)
		: {};
	const baseUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
	if (!baseUrl) throw new Error("DATABASE_URL is not set for tests (.env.test)");
	await prepareTestDatabases({
		baseUrl,
		migrate: (url) => migrateDatabase(url),
		fingerprint: fingerprintFiles(["drizzle", "prisma/migrations"]),
	});
}
