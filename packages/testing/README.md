# @tatara/testing

Part of [tatara](https://github.com/mohammed-bageri/tatara-cli).

Test helpers for tatara apps: call the app in-process, give each Vitest worker its own database
and Redis db, and empty the database between tests. ORM-agnostic: the app passes its own migrate
and seed functions. `pg` and `ioredis` are optional peers, loaded only by the helpers that use them.

## One database per worker

From Vitest's `globalSetup`, Postgres (needs a role with CREATEDB):

```ts
import { fingerprintFiles, flushWorkerRedis, prepareTestDatabases } from "@tatara/testing";

export default async function setup() {
	await prepareTestDatabases({
		baseUrl: process.env.DATABASE_URL!, // postgres://…/app_test
		workers: 4, // = Vitest's maxWorkers
		migrate: (url) => migrateDatabase(url),
		seed: (url) => runBaselineSeeds(url), // optional
		fingerprint: fingerprintFiles(["drizzle"]),
	});
	await flushWorkerRedis(process.env.REDIS_URL!, 4);
}
```

This migrates and seeds `app_test_template`, then copies it to `app_test_1` … `app_test_4` with
`CREATE DATABASE … TEMPLATE` (dropped and recreated every run). The template is rebuilt only when
`fingerprint` changes; without one, every run. `migrate` and `seed` must close their connections,
since Postgres cannot copy a database that has any. An advisory lock keeps two suites on the same
base URL from colliding, but give each checkout its own base URL to run them in parallel.

For other drivers, pass `{ ensureDatabase, migrateDatabase }` instead: each worker database is
created and migrated in place.

In `setupFiles`, point the worker at its own resources before the app's modules load:

```ts
const worker = process.env.VITEST_POOL_ID ?? "1";
process.env.DATABASE_URL = workerDatabaseUrl(process.env.DATABASE_URL!, worker);
process.env.REDIS_URL = workerRedisUrl(process.env.REDIS_URL!, worker);
assertTestRedisUrl(process.env.REDIS_URL);
```

Worker databases are `<db>_<N>`; pass `separator: "_w"` (to both `prepareTestDatabases` and
`workerDatabaseUrl`) for `<db>_w<N>`.

Worker N's Redis db is `16 - N` (workers 1..15), so db 0, where dev data lives, is never one.
`flushRedisDb` and `assertTestRedisUrl` refuse db 0.

## Emptying the database

```ts
beforeEach(() => cleanDatabase(pool, { exclude: ["countries"] }));
```

`cleanDatabase(poolOrClientOrUrl, { schemas?, exclude? })` deletes the rows of only the tables
that have any, with FK triggers off (`session_replication_role = replica`), and restarts their
sequences: milliseconds, where a TRUNCATE of hundreds of tables costs hundreds. It needs a
superuser (or `GRANT SET ON PARAMETER session_replication_role`). Migration tables are always
kept; an excluded table that references a cleaned one keeps rows that now dangle. Lock waits and
deadlocks from leftover background work are retried for about 8s.

With many parallel workers, raise Postgres's `max_locks_per_transaction` (e.g. 1024): copying and
cleaning touch every table.

## Calling the app

```ts
const api = client(app);
const res = await api.post<{ id: string }>("/v1/things", { name: "x" });

const body = await jsonOk<{ id: string }>(await app.request("/v1/things/1"));
const page = await jsonPaginated<{ id: string }>(res); // meta: page, pageSize, total, totalPages
const err = await jsonErr(res); // { success: false, error, code, details? }
```

The `json*` helpers take a `Response` or a `client()` result, check the shape `@tatara/http`
sends, and throw with the status and body when it differs.
