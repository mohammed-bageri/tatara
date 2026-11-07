---
"@tatara/testing": minor
"@tatara/cli": patch
---

`prepareTestDatabases({ migrate, seed?, fingerprint? })` builds a Postgres template database once and copies it per worker, rebuilding it only when the fingerprint changes (`fingerprintFiles`). Adds `cleanDatabase` (deletes only dirty tables, FK triggers off), per-worker Redis dbs (`workerRedisDb`, `workerRedisUrl`, `flushWorkerRedis`, refusing db 0), `separator` for worker database names, and `jsonOk` / `jsonPaginated` / `jsonErr` for `@tatara/http` bodies. Postgres apps' test setup now uses the template.
