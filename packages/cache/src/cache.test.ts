import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCache, memoryStore, orgKey, userKey } from "./index.ts";
import { postgresStore } from "./postgres.ts";
import { redisStore } from "./redis.ts";
import type { CacheStore } from "./store.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// the Redis and Postgres drivers run against real servers when these are set (CI, local docker)
const REDIS_URL = process.env.TATARA_TEST_REDIS_URL;
const DATABASE_URL = process.env.TATARA_TEST_DATABASE_URL;

const closers: (() => Promise<unknown>)[] = [];
afterAll(async () => {
	for (const close of closers) await close();
});

const drivers: [string, (() => CacheStore) | undefined][] = [
	["memory", memoryStore],
	[
		"redis",
		REDIS_URL
			? () => {
					const redis = new Redis(REDIS_URL);
					closers.push(() => redis.quit());
					return redisStore(redis);
				}
			: undefined,
	],
	[
		"postgres",
		DATABASE_URL
			? () => {
					const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
					closers.push(() => pool.end());
					return postgresStore(pool);
				}
			: undefined,
	],
];

for (const [name, make] of drivers) {
	describe.skipIf(!make)(`the ${name} driver`, () => {
		// a fresh namespace per test: drivers that share a server share nothing else
		const fresh = () => createCache((make as () => CacheStore)(), { prefix: randomUUID() });

		it("round-trips JSON values and forgets them after their TTL", async () => {
			const cache = fresh();
			await cache.set("a", { n: 1, tags: ["x"] });
			await cache.set("b", "short", { ttlMs: 50 });
			expect(await cache.get("a")).toEqual({ n: 1, tags: ["x"] });
			expect(await cache.get("b")).toBe("short");
			await wait(120);
			expect(await cache.get("b")).toBeNull();
			expect(await cache.get("missing")).toBeNull();
		});

		it("deletes keys one by one and by prefix, leaving the rest", async () => {
			const cache = fresh();
			await cache.set(orgKey("o1", "a"), 1);
			await cache.set(orgKey("o1", "b"), 2);
			await cache.set(orgKey("o10", "a"), 3);
			await cache.set("x%_\\*", 4);
			expect(await cache.delPrefix(orgKey("o1"))).toBe(2);
			expect(await cache.get(orgKey("o10", "a"))).toBe(3);
			// LIKE and glob characters in a prefix match only themselves
			expect(await cache.delPrefix("x%")).toBe(1);
			await cache.set("y", 5);
			await cache.del("y", orgKey("o10", "a"));
			expect(await cache.get("y")).toBeNull();
			expect(await cache.get(orgKey("o10", "a"))).toBeNull();
		});

		it("adds only when absent, and gives a value out once", async () => {
			const cache = fresh();
			expect(await cache.add("ticket", { userId: "u1" }, { ttlMs: 60_000 })).toBe(true);
			expect(await cache.add("ticket", { userId: "u2" })).toBe(false);
			expect(await cache.take("ticket")).toEqual({ userId: "u1" });
			expect(await cache.take("ticket")).toBeNull();
			await cache.add("brief", 1, { ttlMs: 50 });
			await wait(120);
			expect(await cache.add("brief", 2)).toBe(true);
		});

		it("counts in a fixed window that starts at the first increment", async () => {
			const cache = fresh();
			expect(await cache.increment("hits", { ttlMs: 150 })).toBe(1);
			expect(await cache.increment("hits", { ttlMs: 150 })).toBe(2);
			expect(await cache.increment("hits", { by: 5 })).toBe(7);
			await wait(250);
			expect(await cache.increment("hits", { ttlMs: 150 })).toBe(1);
			expect(
				await Promise.all(Array.from({ length: 20 }, () => cache.increment("race"))),
			).toHaveLength(20);
			expect(await cache.get("race")).toBe(20);
		});

		it("wraps a computation, calling it once while cached", async () => {
			const cache = fresh();
			const fn = vi.fn(async () => ({ total: 42 }));
			expect(await cache.wrap("dash", 60_000, fn)).toEqual({ total: 42 });
			expect(await cache.wrap("dash", 60_000, fn)).toEqual({ total: 42 });
			expect(fn).toHaveBeenCalledTimes(1);
		});

		it("lets one holder run under a lock, and frees it after, even on error", async () => {
			const cache = fresh();
			let release: () => void = () => {};
			const first = cache.lock(
				"nightly",
				60_000,
				() => new Promise<string>((resolve) => (release = () => resolve("ran"))),
			);
			await wait(20);
			expect(await cache.lock("nightly", 60_000, async () => "second")).toEqual({
				acquired: false,
			});
			release();
			expect(await first).toEqual({ acquired: true, value: "ran" });
			await expect(
				cache.lock("nightly", 60_000, async () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			expect(await cache.lock("nightly", 60_000, async () => "again")).toEqual({
				acquired: true,
				value: "again",
			});
		});

		it("keeps a renewed lock past its TTL while the work runs, then frees it", async () => {
			const cache = fresh();
			const slow = cache.lock("long", 60, () => wait(200), { renew: true });
			await wait(130);
			// past two TTLs: without renewal it would have expired
			expect(await cache.lock("long", 60_000, async () => "early")).toEqual({ acquired: false });
			await slow;
			expect(await cache.lock("long", 60_000, async () => "after")).toEqual({
				acquired: true,
				value: "after",
			});
		});

		it("extends a key only while it holds the given value", async () => {
			const store = (make as () => CacheStore)();
			const key = `ext:${randomUUID()}`;
			await store.set(key, "mine", 60);
			expect(await store.extendIfEquals(key, "theirs", 60_000)).toBe(false);
			expect(await store.extendIfEquals(key, "mine", 60_000)).toBe(true);
			await wait(120);
			expect(await store.get(key)).toBe("mine");
			await store.del([key]);
			expect(await store.extendIfEquals(key, "mine", 60_000)).toBe(false);
		});

		it("never frees a lock that expired and was taken by someone else", async () => {
			const cache = fresh();
			const slow = cache.lock("job", 50, () => wait(150));
			await wait(100);
			const other = await cache.lock("job", 60_000, async () => {
				await slow;
				return cache.lock("job", 60_000, async () => "stolen");
			});
			expect(other).toEqual({ acquired: true, value: { acquired: false } });
		});
	});
}

describe("createCache", () => {
	it("falls back to the computation when the store fails, and reports it", async () => {
		const broken = { ...memoryStore(), get: () => Promise.reject(new Error("down")) };
		const onError = vi.fn();
		const cache = createCache(broken, { onError });
		expect(await cache.wrap("k", 1000, async () => "fresh")).toBe("fresh");
		expect(onError).toHaveBeenCalledWith(expect.any(Error), "k");
	});

	it("namespaces keys with the prefix", async () => {
		const store = memoryStore();
		await createCache(store, { prefix: "app" }).set("k", 1);
		expect(await store.get("app:k")).toBe("1");
	});

	it("rejects empty keys, bad TTLs and fractional increments", async () => {
		const cache = createCache(memoryStore());
		await expect(cache.set("", 1)).rejects.toThrow(/empty/);
		await expect(cache.set("k", 1, { ttlMs: 0 })).rejects.toThrow(/TTL/);
		await expect(cache.increment("k", { by: 0.5 })).rejects.toThrow(/whole/);
	});

	it("builds org and user keys whose prefixes don't overlap", () => {
		expect(orgKey("o1", "dash")).toBe("org:o1:dash");
		expect(orgKey("o1")).toBe("org:o1:");
		expect(orgKey("o10", "x").startsWith(orgKey("o1"))).toBe(false);
		expect(userKey("u:1", "prefs")).toBe("user:u%3A1:prefs");
	});
});
