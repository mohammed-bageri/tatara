import { createCache, memoryStore } from "@tatara/cache";
import { beforeEach, describe, expect, it } from "vitest";
import { createPermissionCache } from "./cache.ts";
import type { EffectivePermissions } from "./types.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createPermissionCache with shared cache", () => {
	let sharedCache: ReturnType<typeof createCache>;

	beforeEach(() => {
		sharedCache = createCache(memoryStore(), { prefix: "test" });
	});

	it("without shared cache, behaves as in-process only", async () => {
		const cache = createPermissionCache(30_000);
		const value: EffectivePermissions = {
			grants: [{ resource: "doc", action: "read", scope: "own" }],
			denies: new Set(),
			roles: ["member"],
		};

		await cache.set("org1", "user1", ["member"], value);
		expect(await cache.get("org1", "user1", ["member"])).toEqual(value);

		await cache.invalidateMember("user1", "org1");
		expect(await cache.get("org1", "user1", ["member"])).toBeUndefined();
	});

	it("with shared cache, invalidation on one instance is seen by another", async () => {
		const cache1 = createPermissionCache(30_000, { sharedCache, localTtlMs: 500 });
		const cache2 = createPermissionCache(30_000, { sharedCache, localTtlMs: 500 });

		const value: EffectivePermissions = {
			grants: [{ resource: "doc", action: "read", scope: "org" }],
			denies: new Set(),
			roles: ["admin"],
		};

		// Cache1 sets a value
		await cache1.set("org1", "user1", ["admin"], value);

		// Cache2 should see it (after local cache expires)
		await wait(600);
		expect(await cache2.get("org1", "user1", ["admin"])).toEqual(value);

		// Cache1 invalidates
		await cache1.invalidateMember("user1", "org1");

		// Cache2 should NOT see the old value (even within local TTL, version changed)
		await wait(100);
		expect(await cache2.get("org1", "user1", ["admin"])).toBeUndefined();
	});

	it("local cache layer absorbs hot paths", async () => {
		const cache = createPermissionCache(30_000, { sharedCache, localTtlMs: 200 });
		const value: EffectivePermissions = {
			grants: [{ resource: "task", action: "write", scope: "team" }],
			denies: new Set(),
			roles: ["manager"],
		};

		await cache.set("org1", "user2", ["manager"], value);

		// First get hits shared cache
		const result1 = await cache.get("org1", "user2", ["manager"]);
		expect(result1).toEqual(value);

		// Second get within localTtlMs hits local cache (we can't prove this directly,
		// but we verify it doesn't break)
		const result2 = await cache.get("org1", "user2", ["manager"]);
		expect(result2).toEqual(value);

		// After local TTL expires, still works
		await wait(250);
		const result3 = await cache.get("org1", "user2", ["manager"]);
		expect(result3).toEqual(value);
	});

	it("invalidateAll reaches orgs only another process cached", async () => {
		const cache1 = createPermissionCache(30_000, { sharedCache, localTtlMs: 500 });
		const cache2 = createPermissionCache(30_000, { sharedCache, localTtlMs: 500 });

		const value: EffectivePermissions = {
			grants: [{ resource: "report", action: "read", scope: "org" }],
			denies: new Set(),
			roles: ["viewer"],
		};

		// org2 is cached by cache2 only: cache1 has never seen it
		await cache1.set("org1", "user1", ["viewer"], value);
		await cache2.set("org2", "user2", ["viewer"], value);

		// Wait for local cache to expire so cache2 can fetch from shared
		await wait(600);
		expect(await cache2.get("org1", "user1", ["viewer"])).toEqual(value);
		expect(await cache2.get("org2", "user2", ["viewer"])).toEqual(value);

		// Invalidate all on cache1
		await cache1.invalidateAll();

		// Cache2 should not see the old values
		await wait(100);
		expect(await cache2.get("org1", "user1", ["viewer"])).toBeUndefined();
		expect(await cache2.get("org2", "user2", ["viewer"])).toBeUndefined();
	});

	it("handles denies correctly", async () => {
		const cache = createPermissionCache(30_000, { sharedCache });
		const value: EffectivePermissions = {
			grants: [{ resource: "file", action: "delete", scope: "own" }],
			denies: new Set(["file:write:*"]),
			roles: ["restricted"],
		};

		await cache.set("org1", "user1", ["restricted"], value);
		const cached = await cache.get("org1", "user1", ["restricted"]);

		expect(cached).toEqual(value);
		expect(cached?.denies.has("file:write:*")).toBe(true);
	});

	it("different roles produce different cache keys", async () => {
		const cache = createPermissionCache(30_000, { sharedCache });
		const valueAdmin: EffectivePermissions = {
			grants: [{ resource: "user", action: "manage", scope: "org" }],
			denies: new Set(),
			roles: ["admin"],
		};
		const valueMember: EffectivePermissions = {
			grants: [{ resource: "user", action: "read", scope: "own" }],
			denies: new Set(),
			roles: ["member"],
		};

		await cache.set("org1", "user1", ["admin"], valueAdmin);
		await cache.set("org1", "user1", ["member"], valueMember);

		expect(await cache.get("org1", "user1", ["admin"])).toEqual(valueAdmin);
		expect(await cache.get("org1", "user1", ["member"])).toEqual(valueMember);
	});

	const sample: EffectivePermissions = {
		grants: [{ resource: "report", action: "read", scope: "org" }],
		denies: new Set(),
		roles: ["viewer"],
	};

	it("a member's own invalidations never mask a later org-wide one", async () => {
		const writer = createPermissionCache(30_000, { sharedCache, localTtlMs: 1 });
		const reader = createPermissionCache(30_000, { sharedCache, localTtlMs: 1 });
		// the member's version climbs past anything org-wide
		for (let i = 0; i < 3; i++) await writer.invalidateMember("user1", "org1");
		await writer.set("org1", "user1", ["viewer"], sample);
		await wait(5);
		expect(await reader.get("org1", "user1", ["viewer"])).toEqual(sample);
		await writer.invalidateAll();
		await wait(5);
		expect(await reader.get("org1", "user1", ["viewer"])).toBeUndefined();
	});

	it("invalidating a member in every org reaches other processes", async () => {
		const writer = createPermissionCache(30_000, { sharedCache, localTtlMs: 1 });
		const reader = createPermissionCache(30_000, { sharedCache, localTtlMs: 1 });
		await reader.set("org1", "user1", ["viewer"], sample);
		await reader.set("org2", "user1", ["viewer"], sample);
		await writer.invalidateMember("user1");
		await wait(5);
		expect(await reader.get("org1", "user1", ["viewer"])).toBeUndefined();
		expect(await reader.get("org2", "user1", ["viewer"])).toBeUndefined();
	});

	it("never fails a check or a change when the shared cache fails, and reports it", async () => {
		const broken = createCache(
			{
				...memoryStore(),
				get: async () => {
					throw new Error("redis down");
				},
				set: async () => {
					throw new Error("redis down");
				},
				increment: async () => {
					throw new Error("redis down");
				},
			},
			{ prefix: "broken" },
		);
		const errors: unknown[] = [];
		const cache = createPermissionCache(30_000, {
			sharedCache: broken,
			onError: (error) => errors.push(error),
		});
		await expect(cache.set("org1", "user1", ["viewer"], sample)).resolves.toBeUndefined();
		await expect(cache.get("org1", "user1", ["viewer"])).resolves.toBeUndefined();
		await expect(cache.invalidateMember("user1", "org1")).resolves.toBeUndefined();
		await expect(cache.invalidateAll()).resolves.toBeUndefined();
		expect(errors.length).toBeGreaterThanOrEqual(4);
	});

	it("tells the app what was invalidated, with or without a shared cache", async () => {
		for (const options of [{}, { sharedCache }]) {
			const events: unknown[] = [];
			const cache = createPermissionCache(30_000, {
				...options,
				onInvalidate: (event) => {
					events.push(event);
				},
			});
			await cache.invalidateMember("user1", "org1");
			await cache.invalidateMember("user2");
			await cache.invalidateAll();
			expect(events).toEqual([
				{ kind: "member", userId: "user1", orgId: "org1" },
				{ kind: "member", userId: "user2" },
				{ kind: "all" },
			]);
		}
	});
});
