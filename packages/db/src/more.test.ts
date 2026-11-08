import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runCommand } from "@tatara/core";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { dbCommands } from "./commands.ts";
import { drizzleMigrationStatus } from "./index.ts";
import { explain, explainText } from "./postgres.ts";
import {
	discoverServiceFiles,
	drizzleOperators,
	loadServices,
	startTinker,
	tinkerCommand,
} from "./tinker.ts";

function tmp() {
	return mkdtempSync(join(tmpdir(), "tatara-db-"));
}

describe("drizzleMigrationStatus", () => {
	it("marks migrations applied by hash or by journal when, in journal order", async () => {
		const folder = tmp();
		mkdirSync(join(folder, "meta"));
		writeFileSync(
			join(folder, "meta", "_journal.json"),
			JSON.stringify({
				entries: [
					{ idx: 2, tag: "0002_c", when: 3000 },
					{ idx: 0, tag: "0000_a", when: 1000 },
					{ idx: 1, tag: "0001_b", when: 2000 },
				],
			}),
		);
		writeFileSync(join(folder, "0000_a.sql"), "create table a ();");
		writeFileSync(join(folder, "0001_b.sql"), "create table b ();");
		writeFileSync(join(folder, "0002_c.sql"), "create table c ();");
		const { createHash } = await import("node:crypto");
		const hashA = createHash("sha256").update("create table a ();").digest("hex");
		const report = drizzleMigrationStatus(folder, [
			{ hash: hashA, createdAt: 999 },
			{ hash: "unknown", createdAt: 2000 },
		]);
		expect(report).toEqual({
			statuses: [
				{ tag: "0000_a", applied: true, appliedAt: new Date(999).toISOString() },
				{ tag: "0001_b", applied: true, appliedAt: new Date(2000).toISOString() },
				{ tag: "0002_c", applied: false, appliedAt: null },
			],
			appliedCount: 2,
			pendingCount: 1,
		});
	});

	it("is a db command when the app passes migrationStatus", async () => {
		const migrationStatus = vi.fn(async () => ({ statuses: [], appliedCount: 0, pendingCount: 0 }));
		const base = {
			env: { DATABASE_URL: "postgres://x", NODE_ENV: "development" },
			migrateDatabase: async () => {},
			dropAllTables: async () => {},
			seeds: [],
		};
		expect(dbCommands(base).map((c) => c.name)).not.toContain("db:migration-status");
		const commands = dbCommands({ ...base, migrationStatus });
		expect(await runCommand(commands, ["db:migration-status"], pino({ level: "silent" }))).toBe(0);
		expect(migrationStatus).toHaveBeenCalledWith("postgres://x");
	});
});

describe("explain", () => {
	const query = { toSQL: () => ({ sql: "select * from t where id = $1", params: [1] }) };

	it("prefixes EXPLAIN with the asked-for flags", async () => {
		const calls: [string, unknown[]][] = [];
		const client = {
			async query(sql: string, params: unknown[]) {
				calls.push([sql, params]);
				return sql.includes("JSON")
					? { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan" } }] }] }
					: { rows: [{ "QUERY PLAN": "Seq Scan on t" }, { "QUERY PLAN": "  Filter: (id = 1)" }] };
			},
		};
		expect(await explain(client, query)).toEqual([{ Plan: { "Node Type": "Seq Scan" } }]);
		expect(await explainText(client, query, { analyze: true, buffers: true, verbose: true })).toBe(
			"Seq Scan on t\n  Filter: (id = 1)",
		);
		await explainText(client, query, { buffers: true });
		expect(calls.map((c) => c[0])).toEqual([
			"EXPLAIN (FORMAT JSON) select * from t where id = $1",
			"EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FORMAT TEXT) select * from t where id = $1",
			"EXPLAIN (FORMAT TEXT) select * from t where id = $1",
		]);
		expect(calls[0]?.[1]).toEqual([1]);
	});
});

describe("tinker", () => {
	function services() {
		const cwd = tmp();
		const dir = join(cwd, "src", "modules", "billing", "services");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "invoice-lines.service.ts"), "export const total = () => 42;\n");
		writeFileSync(join(dir, "broken.service.ts"), "throw new Error('broken');\n");
		writeFileSync(join(dir, "helper.ts"), "export {};\n");
		mkdirSync(join(cwd, "src", "modules", "empty"));
		return cwd;
	}

	it("discovers and loads services by module, skipping files that fail", async () => {
		const cwd = services();
		expect(discoverServiceFiles({ cwd }).map((f) => `${f.module}.${f.name}`)).toEqual([
			"billing.broken",
			"billing.invoiceLines",
		]);
		const failed: string[] = [];
		const loaded = await loadServices({ cwd, onError: (_e, f) => failed.push(f.name) });
		expect((loaded.billing as { invoiceLines: { total(): number } }).invoiceLines.total()).toBe(42);
		expect(failed).toEqual(["broken"]);
	});

	it("picks drizzle operators that exist", () => {
		expect(drizzleOperators({ eq: 1, sql: 2, other: 3 })).toEqual({ eq: 1, sql: 2 });
	});

	it("runs a REPL over the context until it closes, then onExit", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let printed = "";
		output.on("data", (chunk) => {
			printed += String(chunk);
		});
		const onExit = vi.fn();
		const done = startTinker({
			context: () => ({ answer: 41 }),
			banner: () => "hello tinker",
			prompt: "t> ",
			input,
			output,
			onExit,
		});
		await new Promise((r) => setTimeout(r, 20));
		input.write("answer + 1\n");
		await new Promise((r) => setTimeout(r, 20));
		input.end(".exit\n");
		await done;
		expect(printed).toContain("hello tinker");
		expect(printed).toContain("42");
		expect(onExit).toHaveBeenCalledOnce();
		expect(tinkerCommand({ context: () => ({}) }).name).toBe("tinker");
	});
});
