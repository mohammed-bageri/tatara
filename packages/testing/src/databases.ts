import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";

/** Number of Vitest workers; global setup prepares one database per worker. */
export const TEST_WORKERS = 4;

export interface WorkerDatabaseOptions {
	/** Between the base name and the worker number. Default `_` (`app_test_3`); `_w` gives `app_test_w3`. */
	separator?: string;
}

/** postgres://…/app_test → postgres://…/app_test_<worker> */
export function workerDatabaseUrl(
	baseUrl: string,
	worker: number | string,
	options: WorkerDatabaseOptions = {},
): string {
	const url = new URL(baseUrl);
	url.pathname = `${url.pathname}${options.separator ?? "_"}${worker}`;
	return url.toString();
}

function databaseName(url: string): string {
	return decodeURIComponent(new URL(url).pathname.slice(1));
}

function withDatabase(url: string, name: string): string {
	const u = new URL(url);
	u.pathname = `/${encodeURIComponent(name)}`;
	return u.toString();
}

/**
 * A sha256 over the names and contents of every file under `paths` (files or folders,
 * recursive; missing paths are skipped). Pass it as `fingerprint` so the template is
 * rebuilt when the migrations change.
 */
export function fingerprintFiles(
	paths: string[],
	options: { filter?: (file: string) => boolean } = {},
): string {
	const hash = createHash("sha256");
	for (const root of paths) {
		if (!existsSync(root)) continue;
		const files = statSync(root).isDirectory()
			? readdirSync(root, { recursive: true, encoding: "utf8" })
					.map((f) => join(root, f))
					.filter((f) => statSync(f).isFile())
			: [root];
		for (const file of files.sort()) {
			if (options.filter && !options.filter(file)) continue;
			hash.update(file).update("\0").update(readFileSync(file)).update("\0");
		}
	}
	return hash.digest("hex");
}

/** Per worker: create the database, then migrate it. Works with any driver. */
export interface PerWorkerOptions {
	baseUrl: string;
	ensureDatabase: (url: string) => Promise<void>;
	migrateDatabase: (url: string) => Promise<void>;
	workers?: number;
	separator?: string;
}

/** Postgres: migrate and seed one template database, then copy it per worker. */
export interface TemplateOptions {
	baseUrl: string;
	/** Applies the app's migrations to `url`. Must close its connections before returning. */
	migrate: (url: string) => Promise<void>;
	/** Inserts baseline rows into the template. Must close its connections before returning. */
	seed?: (url: string) => Promise<void>;
	/** The template is rebuilt only when this changes (e.g. `fingerprintFiles(["drizzle"])`); omitted, every run. */
	fingerprint?: string;
	workers?: number;
	separator?: string;
	/** Default `<db>_template`. */
	templateName?: string;
	/** The database to connect to for CREATE/DROP DATABASE. Default `postgres`. */
	adminDatabase?: string;
}

const COMMENT_PREFIX = "tatara-test-template:";

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
	const { default: postgres } = await import("pg");
	const client = new postgres.Client({ connectionString: url });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}

async function prepareFromTemplate(options: TemplateOptions, workerUrls: string[]): Promise<void> {
	const base = databaseName(options.baseUrl);
	const template = options.templateName ?? `${base}_template`;
	const adminUrl = withDatabase(options.baseUrl, options.adminDatabase ?? "postgres");
	const templateUrl = withDatabase(options.baseUrl, template);
	const wanted =
		options.fingerprint === undefined ? undefined : `${COMMENT_PREFIX}${options.fingerprint}`;

	await withClient(adminUrl, async (admin) => {
		const quotedTemplate = admin.escapeIdentifier(template);
		// two suites sharing a base URL would otherwise rebuild and copy over each other
		await admin.query("select pg_advisory_lock(hashtext($1))", [`tatara-test:${base}`]);
		try {
			const { rows } = await admin.query<{ comment: string | null }>(
				"select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1",
				[template],
			);
			if (wanted === undefined || rows[0]?.comment !== wanted) {
				await admin.query(`drop database if exists ${quotedTemplate} with (force)`);
				await admin.query(`create database ${quotedTemplate}`);
				await options.migrate(templateUrl);
				if (options.seed) await options.seed(templateUrl);
				// written last, so a half-built template is never reused
				if (wanted !== undefined) {
					await admin.query(
						`comment on database ${quotedTemplate} is ${admin.escapeLiteral(wanted)}`,
					);
				}
			}
			// recreated every run so each starts clean; in parallel, as each DROP waits on a checkpoint
			await Promise.all(
				workerUrls.map((url) =>
					withClient(adminUrl, async (c) => {
						const name = c.escapeIdentifier(databaseName(url));
						await c.query(`drop database if exists ${name} with (force)`);
						await c.query(`create database ${name} template ${quotedTemplate}`);
					}),
				),
			);
		} finally {
			await admin.query("select pg_advisory_unlock(hashtext($1))", [`tatara-test:${base}`]);
		}
	});
}

/**
 * Prepares one database per test worker; use from Vitest's global setup. Returns their URLs.
 *
 * - `{ migrate, seed?, fingerprint? }` (Postgres): builds `<db>_template` once and copies it to
 *   each worker with `CREATE DATABASE … TEMPLATE`. Needs a role with CREATEDB.
 * - `{ ensureDatabase, migrateDatabase }` (any driver): creates and migrates each worker database.
 */
export async function prepareTestDatabases(
	options: TemplateOptions | PerWorkerOptions,
): Promise<string[]> {
	const workerUrls = Array.from({ length: options.workers ?? TEST_WORKERS }, (_, i) =>
		workerDatabaseUrl(options.baseUrl, i + 1, { separator: options.separator }),
	);
	try {
		if ("migrate" in options) {
			await prepareFromTemplate(options, workerUrls);
		} else {
			await Promise.all(
				workerUrls.map(async (url) => {
					await options.ensureDatabase(url);
					await options.migrateDatabase(url);
				}),
			);
		}
	} catch (error) {
		throw new Error(
			`Could not prepare the test databases. Is the database running? (\`docker compose up -d --wait\`)\n${String(error)}`,
			{ cause: error },
		);
	}
	return workerUrls;
}
