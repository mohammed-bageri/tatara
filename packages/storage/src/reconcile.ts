import { organizationIdFromKey } from "./keys.ts";
import type { Storage } from "./storage.ts";

/**
 * The app's object metadata (its file rows and the owners they belong to), so reconciliation
 * can tell which objects are still referenced. Both methods get batches and return the subset
 * that exists.
 */
export interface StorageObjectStore {
	/** the keys a metadata row still references */
	referencedKeys(keys: readonly string[]): Promise<ReadonlySet<string>>;
	/** the owners (organizations by default) that still exist */
	existingOwners(ownerIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface FindOrphansOptions {
	storage: Storage;
	objects: StorageObjectStore;
	/** the owner of a key, or null to skip it (default: `organizationIdFromKey`) */
	ownerOf?: (key: string) => string | null;
	/** only list under this prefix */
	prefix?: string;
	/** an unreferenced object under a live owner counts once it is this old (default 24h) */
	minAgeMs?: number;
	/** default 500 */
	batchSize?: number;
	now?: () => number;
}

export interface OrphanObject {
	key: string;
	ownerId: string;
	lastModified?: Date;
	/** `owner_deleted` objects are safe to delete; `old_unreferenced` ones are only reported */
	reason: "owner_deleted" | "old_unreferenced";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Objects under an owner with no metadata row: the owner is gone, or the object is old. */
export async function findOrphanObjects({
	storage,
	objects,
	ownerOf = (key) => organizationIdFromKey(key),
	prefix,
	minAgeMs = DAY_MS,
	batchSize = 500,
	now = Date.now,
}: FindOrphansOptions): Promise<OrphanObject[]> {
	const owned = (await storage.list(prefix)).flatMap((obj) => {
		const ownerId = ownerOf(obj.key);
		return ownerId ? [{ ...obj, ownerId }] : [];
	});
	const orphans: OrphanObject[] = [];
	const at = now();
	for (let i = 0; i < owned.length; i += batchSize) {
		const batch = owned.slice(i, i + batchSize);
		const referenced = await objects.referencedKeys(batch.map((o) => o.key));
		const unreferenced = batch.filter((o) => !referenced.has(o.key));
		if (!unreferenced.length) continue;
		const live = await objects.existingOwners([...new Set(unreferenced.map((o) => o.ownerId))]);
		for (const o of unreferenced) {
			const reason = !live.has(o.ownerId)
				? "owner_deleted"
				: o.lastModified && at - o.lastModified.getTime() > minAgeMs
					? "old_unreferenced"
					: null;
			if (reason)
				orphans.push({
					key: o.key,
					ownerId: o.ownerId,
					...(o.lastModified ? { lastModified: o.lastModified } : {}),
					reason,
				});
		}
	}
	return orphans;
}

export interface ReconcileSummary {
	ownerDeleted: number;
	unreferencedLive: number;
	deleted: number;
	failed: number;
}

interface ReconcileLogger {
	info(obj: object, msg: string): void;
	error(obj: object, msg: string): void;
}

/**
 * Reports orphans; with `apply`, deletes only those whose owner is gone. Old objects with no row
 * under a live owner are never deleted: not every upload path has to record a row.
 */
export async function reconcileOrphanObjects(
	options: FindOrphansOptions & { apply: boolean; logger?: ReconcileLogger },
): Promise<ReconcileSummary> {
	const { apply, logger, storage } = options;
	const orphans = await findOrphanObjects(options);
	const deletable = orphans.filter((o) => o.reason === "owner_deleted");
	const summary: ReconcileSummary = {
		ownerDeleted: deletable.length,
		unreferencedLive: orphans.length - deletable.length,
		deleted: 0,
		failed: 0,
	};
	logger?.info(
		{ ...summary, examples: orphans.slice(0, 10).map(({ key, reason }) => ({ key, reason })) },
		apply
			? "orphan objects found; deleting those of deleted owners"
			: "orphan objects found (dry run)",
	);
	if (!apply) return summary;
	for (const orphan of deletable) {
		try {
			await storage.delete(orphan.key);
			summary.deleted += 1;
		} catch (err) {
			summary.failed += 1;
			logger?.error({ err, key: orphan.key }, "failed to delete orphan object");
		}
	}
	logger?.info(summary, "orphan object reconciliation complete");
	return summary;
}
