# @tatara/jobs

## 0.5.2

### Patch Changes

- Updated dependencies [1882c35]
  - @tatara/core@0.2.0

## 0.5.1

### Patch Changes

- 5347a87: Schedules take an optional `description`, like consumers.

## 0.5.0

### Minor Changes

- bf19561: A job carries the id of the request that enqueued it: `enqueue(topic, data, { requestId })`, `ctx.requestId` in the consumer, and on the job's log lines. The Postgres driver adds a nullable `request_id` column to its table.

## 0.4.0

### Minor Changes

- 9f720bd: `cache.lock(key, ttlMs, fn, { renew: true })` extends the lock every `ttlMs / 2` while `fn` runs, so long work keeps it and a crashed holder's lock still expires. Stores implement `extendIfEquals(key, value, ttlMs)` (redis, postgres and memory do); a custom `CacheStore` must add it.
  
  Schedules no longer overlap themselves across processes: when the schedule lock can hold (`lock`, as `cache` does), a run holds a renewed `schedule:<name>:running` lock, and a tick that finds the previous run still going is skipped and logged. Ticks are still claimed once each, as before.

## 0.3.1

### Patch Changes

- c0671ca: Reject duplicate consumers per topic and executor with non-Postgres drivers

## 0.3.0

### Minor Changes

- 3fac4cc: Jobs v2: one job envelope (`id, topic, data, orgId, attempt, maxAttempts`) over drivers — `inline` (tests), `postgres` (`tatara.jobs`, SKIP LOCKED; a transactional outbox with `{ executor }`), `bullmq` (default) and `kafka` (kafkajs; delayed and dead topics). Retries double from `backoffMs`; `onDeadLetter` runs once, after the last attempt; a payload that doesn't validate is dead at once. `createJobs<TopicsOf<typeof consumers>>` types `enqueue`. Schedules lock through any `lock()` (the cache), get `forEachOrg`, and can be started from outside: `schedule:run` and `triggerSchedule` for an HTTP trigger. Generated apps pick `JOBS_DRIVER`, bring the cache add-on with jobs, and mount `POST /internal/schedules/:name` when `SCHEDULE_TRIGGER_SECRET` is set. Codemod 0.11.0 `jobs-drivers`.

### Patch Changes

- Updated dependencies [315003d]
  - @tatara/core@0.1.2

## 0.2.0

### Minor Changes

- fd669b1: Generated apps are smaller:
  - tatara's own wiring tests no longer go into apps; the e2e matrix runs them.
  - `@tatara/authz` ships the Prisma and Drizzle stores (`prismaAuthzStore(db)`, `drizzleAuthzStore(db, tables)`).
  - The db, authz, email, storage and jobs commands and seeds come from their packages. Packages declare them in a `"tatara"` field, and `tatara sync` wires them into `src/generated`. An app's own command with the same name wins.
  
  `tatara upgrade` now bumps every `@tatara/*` dependency to this CLI's version and installs before syncing. The 0.9.0 codemods remove the copies that are no longer needed.
