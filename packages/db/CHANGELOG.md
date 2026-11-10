# @tatara/db

## 0.3.3

### Patch Changes

- cbe1757: Event definitions take an optional `label` (how a UI names the event). `isBlockedResponse(error)` from @tatara/ai tells a safety refusal from a failed request. `clientIp(c, { trustedHeader })` reads the address the app's own proxy sets (x-real-ip, cf-connecting-ip). More tests for the database error helpers.

## 0.3.2

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.
- Updated dependencies [9b9ac7f]
  - @tatara/core@0.2.1

## 0.3.1

### Patch Changes

- Updated dependencies [1882c35]
  - @tatara/core@0.2.0

## 0.3.0

### Minor Changes

- 279dda4: `@tatara/db`: database error helpers — `extractDbError` (code / errno / constraint from Postgres, MySQL, Drizzle-wrapped and Prisma errors), `isUniqueViolation(err, constraint?)`, `isRetryableTxConflict`, `retryOnceOnTxConflict`, `likePattern`, and query-error redaction for logs (`isDbQueryError`, `sanitizeDbQueryError`, `redactDbQueryErrors`). `drizzleMigrationStatus(folder, applied)` with `appliedMigrations(url)` in `/drizzle-postgres` and `/drizzle-mysql`, and an optional `migrationStatus` for `dbCommands` that adds `db:migration-status`. `explain` / `explainText` in `/postgres`. New `@tatara/db/tinker`: `tinkerCommand`, `startTinker`, `discoverServiceFiles`, `loadServices`, `drizzleOperators`.

## 0.2.2

### Patch Changes

- 315003d: Operations. `@tatara/core`: a `deploy` command (commands with `phase: "deploy"` every deploy, `phase: "once"` once per database, recorded in a ledger; `db:migrate` runs first, `authz:sync-permissions` after), `createEncryption` (AES-256-GCM, rotatable keys), `randomCode`/`numericCode`/`randomToken`/`hashToken`/`safeEqual`, and `cleanText`/`safeUrl` with the `text()`/`url()` zod fields. `@tatara/db`: `commandLedger(url)` per driver; a Postgres reset also drops the `tatara` schema. New `@tatara/observability` and `observability` add-on: OpenTelemetry traces and metrics over OTLP/HTTP with auto-instrumentation, Hono request spans, trace ids on log lines, instrumented processes through `--import ./dist/apps/instrument.mjs`. Codemod 0.11.0 `deploy-ledger`.
- Updated dependencies [315003d]
  - @tatara/core@0.1.2

## 0.2.1

### Patch Changes

- b0727b7: The app owns its auth. Generated apps keep auth in `src/modules/users` (built with `createAuthInstance`), compose HTTP in `src/apps/http.ts`, and with the admin add-on get a `staff` module with its own better-auth. Requests name their org (`requireOrg()`, `x-org-id`); a Keycloak token's `organization` claim decides which orgs its user may act in; authz has no default org, so single-tenant apps set `singleTenant`. `tatara upgrade` moves existing apps (codemod 0.10.0). The MySQL test reset deletes rows instead of truncating.

## 0.2.0

### Minor Changes

- fd669b1: Generated apps are smaller:
  - tatara's own wiring tests no longer go into apps; the e2e matrix runs them.
  - `@tatara/authz` ships the Prisma and Drizzle stores (`prismaAuthzStore(db)`, `drizzleAuthzStore(db, tables)`).
  - The db, authz, email, storage and jobs commands and seeds come from their packages. Packages declare them in a `"tatara"` field, and `tatara sync` wires them into `src/generated`. An app's own command with the same name wins.
  
  `tatara upgrade` now bumps every `@tatara/*` dependency to this CLI's version and installs before syncing. The 0.9.0 codemods remove the copies that are no longer needed.

## 0.1.1

### Patch Changes

- b9ff8c7: `tatara eject <package> [--with-dependents]` copies a package's source into `src/ejected/<name>` and points the app's imports at it. After that, `tatara upgrade`, `sync` and the generators use the app's copy. Library packages now ship their `src` (without tests), so they can be ejected.
- Updated dependencies [b9ff8c7]
  - @tatara/core@0.1.1
