import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { errorSchema, paginated, success } from "@tatara/http";
import { Hono } from "hono";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	assertTestRedisUrl,
	cleanDatabase,
	client,
	type ErrorBody,
	fingerprintFiles,
	flushRedisDb,
	flushWorkerRedis,
	jsonErr,
	jsonOk,
	jsonPaginated,
	type PaginatedBody,
	prepareTestDatabases,
	type SuccessBody,
	TEST_WORKERS,
	workerDatabaseUrl,
	workerRedisDb,
	workerRedisUrl,
} from "./index.ts";

const DATABASE_URL = process.env.TATARA_TEST_DATABASE_URL;
const REDIS_URL = process.env.TATARA_TEST_REDIS_URL;

describe("client", () => {
	const app = new Hono();
	app.post("/echo", async (c) =>
		c.json({ got: await c.req.json(), auth: c.req.header("authorization") ?? null }),
	);
	app.delete("/remove", async (c) => {
		const body = await c.req.json().catch(() => null);
		return c.json({ method: "DELETE", body });
	});
	app.get("/text", (c) => c.text("plain"));
	const api = client(app);

	it("sends JSON and parses JSON", async () => {
		const res = await api.post<{ got: unknown; auth: string }>(
			"/echo",
			{ a: 1 },
			{ headers: { authorization: "Bearer t" } },
		);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ got: { a: 1 }, auth: "Bearer t" });
	});

	it("keeps a non-JSON body as text", async () => {
		expect((await api.get("/text")).body).toBe("plain");
	});

	it("sends DELETE with body", async () => {
		const res = await api.delete<{ method: string; body: unknown }>("/remove", {
			body: { ban: true },
		});
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ method: "DELETE", body: { ban: true } });
	});

	it("sends DELETE without body", async () => {
		const res = await api.delete<{ method: string; body: null }>("/remove");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ method: "DELETE", body: null });
	});
});

describe("response helpers", () => {
	const app = new Hono();
	app.get("/one", (c) => c.json({ success: true, data: { id: "a" } }));
	app.get("/page", (c) =>
		c.json({
			success: true,
			data: [{ id: "a" }],
			meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
		}),
	);
	app.get("/err", (c) => c.json({ success: false, error: "Nope", code: "NOT_FOUND" }, 404));

	it("match the bodies @tatara/http sends", () => {
		type Item = { id: string };
		expectTypeOf<ReturnType<typeof success<Item>>>().toEqualTypeOf<SuccessBody<Item>>();
		expectTypeOf<ReturnType<typeof paginated<Item>>>().toEqualTypeOf<PaginatedBody<Item>>();
		expectTypeOf<(typeof errorSchema)["_output"]>().toEqualTypeOf<ErrorBody>();
	});

	it("read a Response or a client() result", async () => {
		expect((await jsonOk<{ id: string }>(await app.request("/one"))).data.id).toBe("a");
		expect((await jsonOk(await client(app).get("/one"))).data).toEqual({ id: "a" });
		expect((await jsonPaginated(await app.request("/page"))).meta.total).toBe(1);
		expect((await jsonErr(await app.request("/err"))).code).toBe("NOT_FOUND");
	});

	it("throw with the body on the wrong shape", async () => {
		await expect(jsonOk(await app.request("/err"))).rejects.toThrow(/404: .*NOT_FOUND/);
		await expect(jsonPaginated(await app.request("/one"))).rejects.toThrow(/paginated/);
		await expect(jsonErr(await app.request("/one"))).rejects.toThrow(/error body/);
	});
});

describe("worker names", () => {
	it("gives each worker its own database", () => {
		expect(workerDatabaseUrl("postgres://u:p@localhost:5432/app_test", 3)).toBe(
			"postgres://u:p@localhost:5432/app_test_3",
		);
		expect(workerDatabaseUrl("postgres://localhost/app_test", 3, { separator: "_w" })).toBe(
			"postgres://localhost/app_test_w3",
		);
	});

	it("gives worker N Redis db 16 - N, never 0", () => {
		expect(workerRedisDb(1)).toBe(15);
		expect(workerRedisDb("15")).toBe(1);
		expect(() => workerRedisDb(16)).toThrow(/1\.\.15/);
		expect(() => workerRedisDb(0)).toThrow();
		expect(workerRedisUrl("redis://:pw@localhost:6379/0", 2)).toBe("redis://:pw@localhost:6379/14");
	});

	it("refuses Redis db 0", async () => {
		expect(() => assertTestRedisUrl("redis://localhost:6379")).toThrow(/non-zero/);
		expect(() => assertTestRedisUrl("redis://localhost:6379/0")).toThrow(/non-zero/);
		expect(() => assertTestRedisUrl("redis://localhost:6379/3")).not.toThrow();
		await expect(flushRedisDb("redis://localhost:1/0")).rejects.toThrow(/non-zero/);
	});
});

describe("fingerprintFiles", () => {
	it("changes when a file changes, and skips missing paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "tatara-fp-"));
		writeFileSync(join(dir, "0001.sql"), "create table a ();");
		const first = fingerprintFiles([dir, join(dir, "missing")]);
		expect(fingerprintFiles([dir])).toBe(first);
		writeFileSync(join(dir, "0002.sql"), "create table b ();");
		expect(fingerprintFiles([dir])).not.toBe(first);
		expect(fingerprintFiles([dir], { filter: (f) => f.endsWith("0001.sql") })).toBe(first);
	});
});

describe("prepareTestDatabases, per worker", () => {
	it("creates and migrates one database per worker", async () => {
		const ensureDatabase = vi.fn(async () => {});
		const migrateDatabase = vi.fn(async () => {});
		const urls = await prepareTestDatabases({
			baseUrl: "postgres://localhost/app_test",
			ensureDatabase,
			migrateDatabase,
		});
		expect(ensureDatabase).toHaveBeenCalledTimes(TEST_WORKERS);
		expect(migrateDatabase).toHaveBeenCalledWith("postgres://localhost/app_test_1");
		expect(urls).toHaveLength(TEST_WORKERS);
	});

	it("explains a failure", async () => {
		await expect(
			prepareTestDatabases({
				baseUrl: "postgres://localhost/app_test",
				ensureDatabase: async () => {
					throw new Error("ECONNREFUSED");
				},
				migrateDatabase: async () => {},
			}),
		).rejects.toThrow(/Is the database running\?.*ECONNREFUSED/s);
	});
});

describe.skipIf(!DATABASE_URL)("Postgres", () => {
	const base = `tatara_testing_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
	const baseUrl = (() => {
		const u = new URL(DATABASE_URL ?? "postgres://localhost/postgres");
		u.pathname = `/${base}`;
		return u.toString();
	})();
	const created = [`${base}_template`, `${base}_w1`, `${base}_w2`];

	afterAll(async () => {
		const admin = new pg.Client({ connectionString: DATABASE_URL });
		await admin.connect();
		for (const name of created) await admin.query(`drop database if exists "${name}" with (force)`);
		await admin.end();
	});

	const query = async <T>(url: string, text: string): Promise<T[]> => {
		const c = new pg.Client({ connectionString: url });
		await c.connect();
		try {
			return (await c.query(text)).rows as T[];
		} finally {
			await c.end();
		}
	};

	const migrate = vi.fn(async (url: string) => {
		await query(
			url,
			`create table parent (id serial primary key, name text);
			 create table child (id bigint generated always as identity primary key,
				parent_id int not null references parent(id));
			 create table lookup (code text primary key);
			 create table "_prisma_migrations" (id text primary key)`,
		);
	});
	const seed = vi.fn(async (url: string) => {
		await query(url, "insert into lookup values ('a'), ('b')");
	});

	it("builds the template once and copies it per worker", async () => {
		const options = {
			baseUrl,
			migrate,
			seed,
			fingerprint: "v1",
			workers: 2,
			separator: "_w",
		};
		const urls = await prepareTestDatabases(options);
		expect(urls.map((u) => new URL(u).pathname)).toEqual([`/${base}_w1`, `/${base}_w2`]);
		const [w1] = urls as [string, string];
		expect(await query(w1, "select code from lookup order by code")).toEqual([
			{ code: "a" },
			{ code: "b" },
		]);

		// a worker's writes are gone on the next run; the template is reused
		await query(w1, "insert into lookup values ('c')");
		await prepareTestDatabases(options);
		expect(migrate).toHaveBeenCalledTimes(1);
		expect(await query(w1, "select count(*)::int as n from lookup")).toEqual([{ n: 2 }]);

		await prepareTestDatabases({ ...options, fingerprint: "v2" });
		expect(migrate).toHaveBeenCalledTimes(2);
		expect(seed).toHaveBeenCalledTimes(2);
	});

	it("cleanDatabase empties dirty tables and restarts their sequences", async () => {
		const url = `${baseUrl}_w1`;
		await query(
			url,
			`insert into parent (name) values ('p'); insert into child (parent_id) values (1);
			 insert into "_prisma_migrations" values ('m')`,
		);
		const pool = new pg.Pool({ connectionString: url, max: 2 });
		try {
			await cleanDatabase(pool, { exclude: ["lookup"] });
			await cleanDatabase(pool, { exclude: ["lookup"] }); // nothing dirty: a no-op
		} finally {
			await pool.end();
		}
		expect(await query(url, "select count(*)::int as n from parent")).toEqual([{ n: 0 }]);
		expect(await query(url, "select count(*)::int as n from child")).toEqual([{ n: 0 }]);
		expect(await query(url, "select count(*)::int as n from lookup")).toEqual([{ n: 2 }]);
		expect(await query(url, `select count(*)::int as n from "_prisma_migrations"`)).toEqual([
			{ n: 1 },
		]);
		expect(await query(url, "insert into parent (name) values ('again') returning id")).toEqual([
			{ id: 1 },
		]);

		await cleanDatabase(url);
		expect(await query(url, "select count(*)::int as n from lookup")).toEqual([{ n: 0 }]);
	});

	it("cleanDatabase with roots cleans them and what references them, and keeps the rest", async () => {
		const url = `${baseUrl}_w2`;
		await query(
			url,
			"insert into parent (name) values ('p'); insert into child (parent_id) values (1)",
		);
		await cleanDatabase(url, { roots: ["parent"] });
		expect(await query(url, "select count(*)::int as n from parent")).toEqual([{ n: 0 }]);
		expect(await query(url, "select count(*)::int as n from child")).toEqual([{ n: 0 }]);
		// seeded, and neither a root nor referencing one
		expect(await query(url, "select count(*)::int as n from lookup")).toEqual([{ n: 2 }]);
	});
});

describe.skipIf(!REDIS_URL)("Redis", () => {
	it("flushes each worker's db and nothing else", async () => {
		const worker = workerRedisUrl(REDIS_URL ?? "", 1);
		const neighbour = workerRedisUrl(REDIS_URL ?? "", 2);
		const key = `tatara-testing:${randomUUID()}`;
		const a = new Redis(worker);
		const b = new Redis(neighbour);
		try {
			await a.set(key, "1");
			await b.set(key, "1", "EX", 60);
			await flushWorkerRedis(REDIS_URL ?? "", 1);
			expect(await a.get(key)).toBeNull();
			expect(await b.get(key)).toBe("1");
		} finally {
			await b.del(key);
			a.disconnect();
			b.disconnect();
		}
	});
});
