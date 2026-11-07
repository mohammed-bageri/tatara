---
"@tatara/authz": minor
---

The shared permission cache invalidates correctly across processes: a cached set is keyed by a global, org, member-in-org and member version together, so `invalidateAll` reaches every process (it used to bump only orgs this process had cached) and a member's own bumps no longer mask an org-wide one (the key took the larger of two counters). `invalidateMember(userId)` without an org reaches other processes too. A failing shared cache never fails a check or a change: `onCacheError` reports it and the check reads the store. New `onInvalidate` option: called after every invalidation (e.g. to drop a revoked member's realtime connections).
