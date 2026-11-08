import { type CommandDefinition, defineCommand, flag } from "@tatara/core";
import { z } from "zod";
import { type FindOrphansOptions, reconcileOrphanObjects } from "./reconcile.ts";
import type { Storage } from "./storage.ts";

export interface StorageCommandsOptions {
	storage: Storage;
	/** @deprecated unused; still accepted from apps generated before `ensureBucket` existed */
	s3?: unknown;
	/** @deprecated unused, as `s3` */
	env?: unknown;
}

/** storage:check; wired into the app by `tatara sync`. */
export function storageCommands({ storage }: StorageCommandsOptions): CommandDefinition[] {
	return [storageCheckCommand({ storage })];
}

/**
 * Creates the bucket when the driver has one and it is missing, then puts, reads back, signs a
 * URL for and deletes a probe object; so a deploy can prove credentials, endpoint and policy.
 */
export function storageCheckCommand({ storage }: StorageCommandsOptions): CommandDefinition {
	return defineCommand({
		name: "storage:check",
		description:
			"Create the bucket if needed, then put, get, sign a URL for and delete a probe object",
		async run(_args, { logger }) {
			try {
				if (await storage.ensureBucket?.()) logger.info({}, "bucket created");
			} catch (err) {
				// production credentials often may write objects but not inspect buckets; the put below decides
				logger.warn({ err }, "could not check or create the bucket");
			}
			const key = `_healthcheck/${crypto.randomUUID()}.txt`;
			const payload = `storage check ${new Date().toISOString()}`;
			await storage.put(key, payload, "text/plain");
			try {
				const body = await storage.get(key);
				if (new TextDecoder().decode(body ?? new Uint8Array()) !== payload)
					throw new Error("storage round-trip failed: read back a different value (or nothing)");
				const url = await storage.url(key, 60);
				if (!/^(https?|file):\/\//.test(url)) throw new Error(`signed URL looks invalid: ${url}`);
			} finally {
				await storage.delete(key);
			}
			logger.info({ key }, "storage OK: put, get, sign and delete succeeded");
		},
	});
}

/**
 * storage:reconcile-orphan-objects over the app's object metadata. Not wired by `tatara sync`:
 * the app exports it from a command file, since only it knows its file table.
 */
export function reconcileOrphanObjectsCommand(
	options: Omit<FindOrphansOptions, "now">,
): CommandDefinition {
	return defineCommand({
		name: "storage:reconcile-orphan-objects",
		description:
			"Report storage objects with no metadata row; --apply deletes those whose owner is gone",
		args: z.object({ apply: flag() }),
		async run({ apply }, { logger }) {
			await reconcileOrphanObjects({ ...options, apply, logger });
		},
	}) as CommandDefinition;
}
