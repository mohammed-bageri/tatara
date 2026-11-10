# @tatara/testing

## 0.2.2

### Patch Changes

- 7ab6594: `client(app).delete(path, { body })` now supports request bodies. `RequestOptions` gains `body?: unknown`, used by `delete` and ignored by `get`.

## 0.2.1

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.

## 0.2.0

### Minor Changes

- c9627ee: `prepareTestDatabases({ migrate, seed?, fingerprint? })` builds a Postgres template database once and copies it per worker, rebuilding it only when the fingerprint changes (`fingerprintFiles`). Adds `cleanDatabase` (deletes only dirty tables, FK triggers off), per-worker Redis dbs (`workerRedisDb`, `workerRedisUrl`, `flushWorkerRedis`, refusing db 0), `separator` for worker database names, and `jsonOk` / `jsonPaginated` / `jsonErr` for `@tatara/http` bodies. Postgres apps' test setup now uses the template.
  
  `cleanDatabase({ roots })` cleans only the given tables and every table referencing them.

## 0.1.1

### Patch Changes

- b9ff8c7: `tatara eject <package> [--with-dependents]` copies a package's source into `src/ejected/<name>` and points the app's imports at it. After that, `tatara upgrade`, `sync` and the generators use the app's copy. Library packages now ship their `src` (without tests), so they can be ejected.
