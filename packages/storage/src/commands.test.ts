import { mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreLogger } from "@tatara/core";
import { describe, expect, it, vi } from "vitest";
import { reconcileOrphanObjectsCommand, storageCommands } from "./commands.ts";
import { localStorage } from "./local.ts";
import { findOrphanObjects, reconcileOrphanObjects, type StorageObjectStore } from "./reconcile.ts";
import type { Storage } from "./storage.ts";

const logger = () =>
	({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as CoreLogger;

const tmp = () => mkdtemp(join(tmpdir(), "storage-cmd-"));

describe("storage:check", () => {
	it("round-trips, signs and cleans up the probe", async () => {
		const storage = localStorage(await tmp());
		const [check] = storageCommands({ storage });
		await check?.run({}, { logger: logger() });
		expect(await storage.list()).toEqual([]);
	});

	it("creates the bucket, and goes on when it may not inspect it", async () => {
		const storage = localStorage(await tmp());
		const log = logger();
		const ensureBucket = vi
			.fn()
			.mockResolvedValueOnce(true)
			.mockRejectedValueOnce(new Error("403"));
		const [check] = storageCommands({ storage: { ...storage, ensureBucket } });
		await check?.run({}, { logger: log });
		expect(log.info).toHaveBeenCalledWith({}, "bucket created");
		await check?.run({}, { logger: log });
		expect(log.warn).toHaveBeenCalled();
	});

	it("fails on a bad read-back and still deletes the probe", async () => {
		const real = localStorage(await tmp());
		const storage: Storage = { ...real, get: async () => new TextEncoder().encode("other") };
		const [check] = storageCommands({ storage });
		await expect(check?.run({}, { logger: logger() })).rejects.toThrow(/round-trip failed/);
		expect(await real.list()).toEqual([]);
	});
});

/** Metadata rows for `referenced` keys; owners in `owners` exist. */
function store(referenced: string[], owners: string[]): StorageObjectStore & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		async referencedKeys(keys) {
			calls.push([...keys]);
			return new Set(keys.filter((k) => referenced.includes(k)));
		},
		async existingOwners(ids) {
			return new Set(ids.filter((id) => owners.includes(id)));
		},
	};
}

async function bucket() {
	const storage = localStorage(await tmp());
	for (const key of [
		"private/orgs/live/a.pdf", // referenced
		"private/orgs/live/old.pdf", // unreferenced, old
		"public/orgs/live/new.png", // unreferenced, recent
		"private/orgs/gone/x.pdf", // owner deleted
		"_healthcheck/y.txt", // no owner
	])
		await storage.put(key, "1");
	const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	const path = (await storage.url("private/orgs/live/old.pdf")).slice("file://".length);
	await utimes(path, old, old);
	return storage;
}

describe("orphan reconciliation", () => {
	it("finds objects of deleted owners and old unreferenced ones, in batches", async () => {
		const objects = store(["private/orgs/live/a.pdf"], ["live"]);
		const orphans = await findOrphanObjects({ storage: await bucket(), objects, batchSize: 2 });
		expect(orphans.map(({ key, reason, ownerId }) => ({ key, reason, ownerId }))).toEqual([
			{ key: "private/orgs/gone/x.pdf", reason: "owner_deleted", ownerId: "gone" },
			{ key: "private/orgs/live/old.pdf", reason: "old_unreferenced", ownerId: "live" },
		]);
		expect(objects.calls.every((c) => c.length <= 2)).toBe(true);
		expect(objects.calls.flat()).not.toContain("_healthcheck/y.txt");
	});

	it("deletes only objects of deleted owners, and only with apply", async () => {
		const storage = await bucket();
		const objects = store(["private/orgs/live/a.pdf"], ["live"]);
		expect(await reconcileOrphanObjects({ storage, objects, apply: false })).toEqual({
			ownerDeleted: 1,
			unreferencedLive: 1,
			deleted: 0,
			failed: 0,
		});
		expect((await storage.list()).length).toBe(5);
		expect(await reconcileOrphanObjects({ storage, objects, apply: true })).toMatchObject({
			deleted: 1,
		});
		expect((await storage.list()).map((o) => o.key)).not.toContain("private/orgs/gone/x.pdf");
		expect(await storage.get("private/orgs/live/old.pdf")).not.toBeNull();
	});

	it("counts failed deletes and goes on", async () => {
		const real = await bucket();
		const storage: Storage = { ...real, delete: async () => Promise.reject(new Error("boom")) };
		const log = { info: vi.fn(), error: vi.fn() };
		const summary = await reconcileOrphanObjects({
			storage,
			objects: store([], []),
			apply: true,
			logger: log,
		});
		expect(summary).toMatchObject({ ownerDeleted: 4, deleted: 0, failed: 4 });
		expect(log.error).toHaveBeenCalledTimes(4);
	});

	it("runs as a command with an --apply flag and a custom owner", async () => {
		const storage = await bucket();
		const command = reconcileOrphanObjectsCommand({
			storage,
			objects: store([], []),
			ownerOf: (key) => (key.startsWith("_healthcheck/") ? "probe" : null),
		});
		expect(command.name).toBe("storage:reconcile-orphan-objects");
		await command.run(command.args?.parse({ apply: "true" }) ?? {}, { logger: logger() });
		expect(await storage.get("_healthcheck/y.txt")).toBeNull();
		expect((await storage.list()).length).toBe(4);
	});
});
