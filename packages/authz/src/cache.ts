import type { Cache } from "@tatara/cache";
import type { EffectivePermissions } from "./types.ts";

export interface PermissionCache {
	get(orgId: string, userId: string, roles: string[]): Promise<EffectivePermissions | undefined>;
	set(orgId: string, userId: string, roles: string[], value: EffectivePermissions): Promise<void>;
	/** Drops cached sets for one member (any org when orgId is omitted). */
	invalidateMember(userId: string, orgId?: string): Promise<void>;
	/** Role definitions changed: every cached set may be stale. */
	invalidateAll(): Promise<void>;
}

/** What was invalidated: one member (in one org, or everywhere), or everything. */
export type PermissionInvalidation =
	| { kind: "member"; userId: string; orgId?: string }
	| { kind: "all" };

export interface PermissionCacheOptions {
	sharedCache?: Cache;
	localTtlMs?: number;
	/** after every invalidation, e.g. to drop a revoked member's realtime connections */
	onInvalidate?: (event: PermissionInvalidation) => void | Promise<void>;
	/** a shared-cache failure; the check reads the store instead of failing */
	onError?: (error: unknown) => void;
}

/**
 * Permission cache with optional shared backend.
 *
 * When `sharedCache` is provided, uses versioned keys: global, per-org, per-member-in-org and
 * per-member counters in the shared cache that invalidation bumps. A cached entry is keyed by all
 * four, so any bump invalidates every process at once. A very short local in-memory layer (≤1 s,
 * configurable via `localTtlMs`) absorbs hot paths. A failing shared cache is reported through
 * `onError` and the check falls back to the store; it never fails a check.
 *
 * Without a shared cache, behaviour stays as today: an in-process Map with the full `ttlMs`.
 * This means invalidation only clears the local process — with several API replicas, a revoked
 * role or overlay keeps working on the other replicas for up to `ttlMs`.
 */
export function createPermissionCache(
	ttlMs: number,
	options: PermissionCacheOptions = {},
): PermissionCache {
	const { sharedCache, localTtlMs = 1000, onInvalidate, onError } = options;
	const notify = async (event: PermissionInvalidation) => {
		await onInvalidate?.(event);
	};

	if (!sharedCache) {
		// No shared cache: in-process only
		const entries = new Map<string, { value: EffectivePermissions; expires: number }>();
		const key = (orgId: string, userId: string, roles: string[]) =>
			`${orgId}:${userId}:${[...roles].sort().join(",")}`;
		return {
			async get(orgId, userId, roles) {
				const entry = entries.get(key(orgId, userId, roles));
				if (!entry || entry.expires < Date.now()) return undefined;
				return entry.value;
			},
			async set(orgId, userId, roles, value) {
				if (entries.size > 10_000) entries.clear();
				entries.set(key(orgId, userId, roles), { value, expires: Date.now() + ttlMs });
			},
			async invalidateMember(userId, orgId) {
				for (const k of entries.keys()) {
					const [o, u] = k.split(":");
					if (u === userId && (!orgId || o === orgId)) entries.delete(k);
				}
				await notify({ kind: "member", userId, ...(orgId ? { orgId } : {}) });
			},
			async invalidateAll() {
				entries.clear();
				await notify({ kind: "all" });
			},
		};
	}

	// Shared cache with versioned keys + short local layer
	const localCache = new Map<
		string,
		{ value: EffectivePermissions; version: string; expires: number }
	>();
	const GLOBAL = "authz:v";
	const orgKey = (orgId: string) => `authz:v:o:${orgId}`;
	const memberKey = (orgId: string, userId: string) => `authz:v:m:${orgId}:${userId}`;
	const userKey = (userId: string) => `authz:v:u:${userId}`;
	const permKey = (orgId: string, userId: string, roles: string[], version: string) =>
		`authz:p:${orgId}:${userId}:${version}:${[...roles].sort().join(",")}`;
	const localKey = (orgId: string, userId: string, roles: string[]) =>
		`${orgId}:${userId}:${[...roles].sort().join(",")}`;

	/** every counter a cached set depends on: a bump of any one of them changes the key */
	async function version(orgId: string, userId: string): Promise<string> {
		const parts = await Promise.all(
			[GLOBAL, orgKey(orgId), memberKey(orgId, userId), userKey(userId)].map(
				async (key) => (await sharedCache?.get<number>(key)) ?? 0,
			),
		);
		return parts.join(".");
	}

	async function bump(key: string): Promise<void> {
		try {
			await sharedCache?.increment(key);
		} catch (error) {
			// the change is already written: report it (other processes may be stale for up to
			// ttlMs) rather than fail it
			onError?.(error);
		}
	}

	interface SerializedEffectivePermissions {
		grants: EffectivePermissions["grants"];
		denies: string[];
		roles: string[];
	}
	const serialize = (value: EffectivePermissions): SerializedEffectivePermissions => ({
		grants: value.grants,
		denies: Array.from(value.denies),
		roles: value.roles,
	});
	const deserialize = (serialized: SerializedEffectivePermissions): EffectivePermissions => ({
		grants: serialized.grants,
		denies: new Set(serialized.denies),
		roles: serialized.roles,
	});

	return {
		async get(orgId, userId, roles) {
			try {
				const current = await version(orgId, userId);
				const local = localCache.get(localKey(orgId, userId, roles));
				if (local && local.expires >= Date.now() && local.version === current) return local.value;
				const cached = await sharedCache.get<SerializedEffectivePermissions>(
					permKey(orgId, userId, roles, current),
				);
				if (!cached) return undefined;
				const value = deserialize(cached);
				localCache.set(localKey(orgId, userId, roles), {
					value,
					version: current,
					expires: Date.now() + localTtlMs,
				});
				return value;
			} catch (error) {
				onError?.(error);
				return undefined;
			}
		},

		async set(orgId, userId, roles, value) {
			try {
				const current = await version(orgId, userId);
				await sharedCache.set(permKey(orgId, userId, roles, current), serialize(value), {
					ttlMs,
				});
				if (localCache.size > 10_000) localCache.clear();
				localCache.set(localKey(orgId, userId, roles), {
					value,
					version: current,
					expires: Date.now() + localTtlMs,
				});
			} catch (error) {
				onError?.(error);
			}
		},

		async invalidateMember(userId, orgId) {
			await bump(orgId ? memberKey(orgId, userId) : userKey(userId));
			for (const k of localCache.keys()) {
				const [o, u] = k.split(":");
				if (u === userId && (!orgId || o === orgId)) localCache.delete(k);
			}
			await notify({ kind: "member", userId, ...(orgId ? { orgId } : {}) });
		},

		async invalidateAll() {
			await bump(GLOBAL);
			localCache.clear();
			await notify({ kind: "all" });
		},
	};
}
