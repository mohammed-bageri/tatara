---
"@tatara/authz": minor
---

Add optional shared cache support with versioned keys

The permission cache now accepts an optional `sharedCache` parameter (from `@tatara/cache`). When provided, uses versioned keys so invalidation on one process is seen by all others. A short local in-memory layer (≤1 s, configurable via `localCacheTtlMs`) absorbs hot paths. Without a shared cache, behaviour stays as today: an in-process Map with the full `cacheTtlMs`. This means invalidation only clears the local process — with several API replicas, a revoked role or overlay keeps working on the other replicas for up to `cacheTtlMs`.

Breaking change: `PermissionCache` methods (`get`, `set`, `invalidateMember`, `invalidateAll`) are now async and return `Promise`.
