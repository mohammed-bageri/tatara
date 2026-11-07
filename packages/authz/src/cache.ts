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

/**
 * Permission cache with optional shared backend.
 *
 * When `sharedCache` is provided, uses versioned keys: a per-org and per-member version counter
 * in the shared cache that invalidation bumps. Cached entries are keyed by version, so a bump
 * invalidates every process at once. A very short local in-memory layer (≤1 s, configurable via
 * `localTtlMs`) absorbs hot paths.
 *
 * Without a shared cache, behaviour stays as today: an in-process Map with the full `ttlMs`.
 * This means invalidation only clears the local process — with several API replicas, a revoked
 * role or overlay keeps working on the other replicas for up to `ttlMs`.
 */
export function createPermissionCache(
	ttlMs: number,
	options?: { sharedCache?: Cache; localTtlMs?: number },
): PermissionCache {
	const { sharedCache, localTtlMs = 1000 } = options ?? {};

	if (!sharedCache) {
		// No shared cache: in-process only (original behaviour)
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
			},
			async invalidateAll() {
				entries.clear();
			},
		};
	}

	// Shared cache with versioned keys + short local layer
	const localCache = new Map<
		string,
		{ value: EffectivePermissions; version: number; expires: number }
	>();

	const versionKey = (orgId: string, userId?: string) =>
		userId ? `authz:v:${orgId}:${userId}` : `authz:v:${orgId}`;

	const permKey = (orgId: string, userId: string, roles: string[], version: number) =>
		`authz:p:${orgId}:${userId}:${version}:${[...roles].sort().join(",")}`;

	const localKey = (orgId: string, userId: string, roles: string[]) =>
		`${orgId}:${userId}:${[...roles].sort().join(",")}`;

	async function getVersion(orgId: string, userId?: string): Promise<number> {
		if (!sharedCache) return 0;
		const v = await sharedCache.get<number>(versionKey(orgId, userId));
		return v ?? 0;
	}

	async function bumpVersion(orgId: string, userId?: string): Promise<void> {
		if (!sharedCache) return;
		await sharedCache.increment(versionKey(orgId, userId));
	}

	// Serialize/deserialize helpers for Set
	interface SerializedEffectivePermissions {
		grants: EffectivePermissions["grants"];
		denies: string[];
		roles: string[];
	}

	function serialize(value: EffectivePermissions): SerializedEffectivePermissions {
		return {
			grants: value.grants,
			denies: Array.from(value.denies),
			roles: value.roles,
		};
	}

	function deserialize(serialized: SerializedEffectivePermissions): EffectivePermissions {
		return {
			grants: serialized.grants,
			denies: new Set(serialized.denies),
			roles: serialized.roles,
		};
	}

	return {
		async get(orgId, userId, roles) {
			// Check shared cache version first to see if local is stale
			const [orgVersion, memberVersion] = await Promise.all([
				getVersion(orgId),
				getVersion(orgId, userId),
			]);
			const version = Math.max(orgVersion, memberVersion);

			const local = localCache.get(localKey(orgId, userId, roles));
			if (local && local.expires >= Date.now() && local.version === version) {
				return local.value;
			}

			// Fetch from shared cache with current version
			const cached = await sharedCache.get<SerializedEffectivePermissions>(
				permKey(orgId, userId, roles, version),
			);

			if (cached) {
				const value = deserialize(cached);
				// Refresh local cache with current version
				localCache.set(localKey(orgId, userId, roles), {
					value,
					version,
					expires: Date.now() + localTtlMs,
				});
				return value;
			}

			return undefined;
		},

		async set(orgId, userId, roles, value) {
			const [orgVersion, memberVersion] = await Promise.all([
				getVersion(orgId),
				getVersion(orgId, userId),
			]);
			const version = Math.max(orgVersion, memberVersion);

			// Store in shared cache with version (serialized)
			await sharedCache.set(permKey(orgId, userId, roles, version), serialize(value), { ttlMs });

			// Store in local cache
			if (localCache.size > 10_000) localCache.clear();
			localCache.set(localKey(orgId, userId, roles), {
				value,
				version,
				expires: Date.now() + localTtlMs,
			});
		},

		async invalidateMember(userId, orgId) {
			if (orgId) {
				// Bump per-member version in one org
				await bumpVersion(orgId, userId);
				// Clear local entries for this member in this org
				for (const k of localCache.keys()) {
					const [o, u] = k.split(":");
					if (o === orgId && u === userId) localCache.delete(k);
				}
			} else {
				// Member in any org: we'd need to bump every org they're in, but we don't track that.
				// Fall back to clearing local only. Apps should always pass orgId.
				for (const k of localCache.keys()) {
					const [, u] = k.split(":");
					if (u === userId) localCache.delete(k);
				}
			}
		},

		async invalidateAll() {
			// Bump version for every org we've cached (we don't have a global org list, so this
			// is best-effort). In practice, apps call invalidateMember per affected member when
			// a role changes, which is more precise.
			const orgs = new Set<string>();
			for (const k of localCache.keys()) {
				const parts = k.split(":");
				if (parts[0]) orgs.add(parts[0]);
			}
			await Promise.all([...orgs].map((orgId) => bumpVersion(orgId)));
			localCache.clear();
		},
	};
}
