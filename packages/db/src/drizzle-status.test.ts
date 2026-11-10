import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sql = "create table a ();";
const hash = createHash("sha256").update(sql).digest("hex");
const queries: string[] = [];

vi.mock("pg", () => {
	class Client {
		async connect() {}
		async end() {}
		async query(text: string) {
			queries.push(text);
			if (text.includes("to_regclass")) return { rows: [{ found: true }] };
			return { rows: [{ hash, created_at: "1000" }] };
		}
	}
	return { default: { Client, Pool: class {} } };
});

vi.mock("mysql2/promise", () => ({
	default: {
		createConnection: async () => ({
			async end() {},
			async query(text: string) {
				queries.push(text);
				if (text.includes("information_schema")) return [[{ 1: 1 }]];
				return [[{ hash, created_at: 1000 }]];
			},
		}),
	},
}));

let cwd: string;
beforeEach(() => {
	cwd = process.cwd();
	const root = mkdtempSync(join(tmpdir(), "tatara-db-status-"));
	mkdirSync(join(root, "drizzle", "meta"), { recursive: true });
	writeFileSync(
		join(root, "drizzle", "meta", "_journal.json"),
		JSON.stringify({
			entries: [
				{ idx: 0, tag: "0000_a", when: 1000 },
				{ idx: 1, tag: "0001_b", when: 2000 },
			],
		}),
	);
	writeFileSync(join(root, "drizzle", "0000_a.sql"), sql);
	writeFileSync(join(root, "drizzle", "0001_b.sql"), "create table b ();");
	process.chdir(root);
	queries.length = 0;
});
afterEach(() => process.chdir(cwd));

const expected = {
	statuses: [
		{ tag: "0000_a", applied: true, appliedAt: new Date(1000).toISOString() },
		{ tag: "0001_b", applied: false, appliedAt: null },
	],
	appliedCount: 1,
	pendingCount: 1,
};

describe("migrationStatus (the drizzle drivers)", () => {
	it("postgres: reads ./drizzle against drizzle.__drizzle_migrations", async () => {
		const { migrationStatus } = await import("./drizzle-postgres.ts");
		expect(await migrationStatus("postgres://x")).toEqual(expected);
		expect(queries.at(-1)).toContain("from drizzle.__drizzle_migrations");
	});

	it("mysql: reads ./drizzle against __drizzle_migrations", async () => {
		const { migrationStatus } = await import("./drizzle-mysql.ts");
		expect(await migrationStatus("mysql://x")).toEqual(expected);
		expect(queries.at(-1)).toContain("from __drizzle_migrations");
	});
});
