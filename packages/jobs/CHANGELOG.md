# @tatara/jobs

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
