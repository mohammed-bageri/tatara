# create-tatara

## 0.15.2

### Patch Changes

- Updated dependencies [c9627ee]
  - @tatara/cli@0.15.2

## 0.15.1

### Patch Changes

- Updated dependencies [641e260]
  - @tatara/cli@0.15.1

## 0.15.0

### Patch Changes

- Updated dependencies [1869750]
  - @tatara/cli@0.15.0

## 0.14.1

### Patch Changes

- Updated dependencies [d259711]
  - @tatara/cli@0.14.1

## 0.14.0

### Patch Changes

- Updated dependencies [c0671ca]
  - @tatara/cli@0.14.0

## 0.13.2

### Patch Changes

- Updated dependencies [2173039]
  - @tatara/cli@0.13.2

## 0.13.1

### Patch Changes

- Updated dependencies [6d1dd5a]
  - @tatara/cli@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [d9f9578]
  - @tatara/cli@0.13.0

## 0.12.0

### Minor Changes

- 0d778b3: `authz.grantSystemRole(orgId, userId, key)`; generated apps with organizations make an org's creator its `admin` in their own `auth.ts` (and `authzOrganizationHooks` takes `creatorRole`). The notifier takes `allow({ userId, notification, channel, data })`, so the app decides who gets which channel. `sanitizeHtml` (`@tatara/core/html`, with `sanitize-html` installed). `tatara add <add-on…>` adds add-ons to an existing app. Observability registers in-thread ESM hooks (`module.registerHooks`) where Node has them, so Node 26 prints no deprecation; `@tatara/observability/hooks`.

### Patch Changes

- Updated dependencies [0d778b3]
  - @tatara/cli@0.12.0

## 0.11.1

### Patch Changes

- 1902880: Apps with the email add-on and no `emails/*.ts` templates typecheck again (`sendTemplate` read an empty list as `never`).
- Updated dependencies [1902880]
  - @tatara/cli@0.11.1

## 0.11.0

### Minor Changes

- b9fca8f: `@tatara/cache`: one cache contract (`get/set/del/delPrefix/add/take/increment/wrap/lock`, `orgKey`/`userKey`) with memory, Redis and Postgres (unlogged table in its own schema) drivers. New `cache` add-on: `cache` from `#core/cache/index`, picked with `CACHE_DRIVER` (Redis by default, memory in tests).
- 6170cca: `@tatara/http`: `rateLimit` (fixed window over any counter, 429 RATE_LIMITED with Retry-After, fails open), `clientIp`/`withClientIp` (trusted proxy hops), cursor pagination (`cursorQuerySchema`, `cursorPage`, `encodeCursor`/`decodeCursor`), CORS origin patterns (`https://*.example.com`), per-path request timeouts (504 REQUEST_TIMEOUT), and `startServer({ onServer })`. Generated apps time out requests after `REQUEST_TIMEOUT_MS`, give better-auth the caller's real address (`TRUSTED_PROXY_HOPS`), and with the cache add-on get `limitRequests`. New `tatara contracts` writes each app's OpenAPI document and TypeScript types for openapi-fetch clients (`--check` for CI). Codemod 0.11.0 `http-limits`.
- 3fac4cc: Jobs v2: one job envelope (`id, topic, data, orgId, attempt, maxAttempts`) over drivers — `inline` (tests), `postgres` (`tatara.jobs`, SKIP LOCKED; a transactional outbox with `{ executor }`), `bullmq` (default) and `kafka` (kafkajs; delayed and dead topics). Retries double from `backoffMs`; `onDeadLetter` runs once, after the last attempt; a payload that doesn't validate is dead at once. `createJobs<TopicsOf<typeof consumers>>` types `enqueue`. Schedules lock through any `lock()` (the cache), get `forEachOrg`, and can be started from outside: `schedule:run` and `triggerSchedule` for an HTTP trigger. Generated apps pick `JOBS_DRIVER`, bring the cache add-on with jobs, and mount `POST /internal/schedules/:name` when `SCHEDULE_TRIGGER_SECRET` is set. Codemod 0.11.0 `jobs-drivers`.
- 6bcea69: `@tatara/notifications`: `notify({ orgId, to, notification, data })` for in-app, email, SMS and push. Recipients are a user, users, a role or a permission; delivery goes through jobs (fan-out, then one delivery per user), each channel once per recipient, deduped by `idempotencyKey`. `defineNotification` templates in `notifications/*.ts`, Drizzle and Prisma stores, Twilio and FCM senders (console fallbacks). `@tatara/email`: a Mailgun driver and `defineEmail` templates. New `notifications` add-on (brings jobs and the cache): the inbox routes, push tokens, `SMS_DRIVER`/`PUSH_DRIVER`. Codemod 0.11.0 `email-v2`.
- 315003d: Operations. `@tatara/core`: a `deploy` command (commands with `phase: "deploy"` every deploy, `phase: "once"` once per database, recorded in a ledger; `db:migrate` runs first, `authz:sync-permissions` after), `createEncryption` (AES-256-GCM, rotatable keys), `randomCode`/`numericCode`/`randomToken`/`hashToken`/`safeEqual`, and `cleanText`/`safeUrl` with the `text()`/`url()` zod fields. `@tatara/db`: `commandLedger(url)` per driver; a Postgres reset also drops the `tatara` schema. New `@tatara/observability` and `observability` add-on: OpenTelemetry traces and metrics over OTLP/HTTP with auto-instrumentation, Hono request spans, trace ids on log lines, instrumented processes through `--import ./dist/apps/instrument.mjs`. Codemod 0.11.0 `deploy-ledger`.
- 3d71569: `@tatara/realtime`: socket.io with single-use tickets (through the cache), per-user and per-org rooms, module channels (`defineChannel`: a name pattern, `authorize`, zod-checked events), `publishToUser` / `publishToOrg` / `publishTo` from any process (Redis adapter and emitter; a publish has left the process when it resolves), `disconnectUser` / `disconnectOrg`, and a `realtime:publish` command. New `realtime` add-on: `POST /api/realtime/ticket`, the api attaches sockets on its own port (`startServer({ onServer })`), `channels/*.ts` convention, and with notifications every inbox entry is pushed as `notification.created`.

### Patch Changes

- Updated dependencies [b9fca8f]
- Updated dependencies [6170cca]
- Updated dependencies [3fac4cc]
- Updated dependencies [6bcea69]
- Updated dependencies [315003d]
- Updated dependencies [3d71569]
  - @tatara/cli@0.11.0

## 0.10.0

### Minor Changes

- b0727b7: The app owns its auth. Generated apps keep auth in `src/modules/users` (built with `createAuthInstance`), compose HTTP in `src/apps/http.ts`, and with the admin add-on get a `staff` module with its own better-auth. Requests name their org (`requireOrg()`, `x-org-id`); a Keycloak token's `organization` claim decides which orgs its user may act in; authz has no default org, so single-tenant apps set `singleTenant`. `tatara upgrade` moves existing apps (codemod 0.10.0). The MySQL test reset deletes rows instead of truncating.

### Patch Changes

- Updated dependencies [b0727b7]
  - @tatara/cli@0.10.0

## 0.9.2

### Patch Changes

- ae73adc: Label better-auth routes as "better-auth" in `tatara routes`. Routes tagged "Auth" (from better-auth's merged OpenAPI document) now show their auth provider instead of "authenticated" or "public", making them easily identifiable. Also uses operation description as fallback when summary is missing.
- Updated dependencies [ae73adc]
  - @tatara/cli@0.9.2

## 0.9.1

### Patch Changes

- 60c3459: Fix `tatara routes` to include better-auth endpoints. The command now fetches the OpenAPI spec from `/openapi.json` instead of calling `getOpenAPI31Document` directly, ensuring routes added via async extend callbacks are included. Also improves guard labeling for API-key security schemes.
- Updated dependencies [60c3459]
  - @tatara/cli@0.9.1

## 0.9.0

### Minor Changes

- fd669b1: Generated apps are smaller:
  - tatara's own wiring tests no longer go into apps; the e2e matrix runs them.
  - `@tatara/authz` ships the Prisma and Drizzle stores (`prismaAuthzStore(db)`, `drizzleAuthzStore(db, tables)`).
  - The db, authz, email, storage and jobs commands and seeds come from their packages. Packages declare them in a `"tatara"` field, and `tatara sync` wires them into `src/generated`. An app's own command with the same name wins.
  
  `tatara upgrade` now bumps every `@tatara/*` dependency to this CLI's version and installs before syncing. The 0.9.0 codemods remove the copies that are no longer needed.

### Patch Changes

- Updated dependencies [fd669b1]
  - @tatara/cli@0.9.0

## 0.8.0

### Minor Changes

- b9ff8c7: `tatara eject <package> [--with-dependents]` copies a package's source into `src/ejected/<name>` and points the app's imports at it. After that, `tatara upgrade`, `sync` and the generators use the app's copy. Library packages now ship their `src` (without tests), so they can be ejected.

### Patch Changes

- Updated dependencies [b9ff8c7]
  - @tatara/cli@0.8.0

## 0.7.0

### Minor Changes

- 994eb9d: Generated apps use `@tatara/storage`, `@tatara/email`, `@tatara/i18n` and `@tatara/jobs`. Each add-on keeps one short config file (`src/core/<addon>/index.ts` or `send.ts`), and the worker and cron apps call `startWorker`/`startCron`. `tatara upgrade` runs the 0.7.0 `addon-packages` codemod, which moves each add-on on its own.

### Patch Changes

- Updated dependencies [994eb9d]
  - @tatara/cli@0.7.0

## 0.6.0

### Minor Changes

- 2324281: Generated apps with the permission system use `@tatara/authz`: `src/core/authz/index.ts` creates the app's `authz` from its store, catalog and built-in roles, and the authorization routes come from the package. The ORM store stays in the app. `tatara upgrade` runs the 0.6.0 `authz-package` codemod.

### Patch Changes

- Updated dependencies [2324281]
  - @tatara/cli@0.6.0

## 0.5.0

### Minor Changes

- fa60688: Generated apps use `@tatara/auth` (guards, principal middleware, OpenAPI merge, dev outbox, test helpers) and `@tatara/keycloak` (the `keycloakTokens()` plugin and test signer). `tatara upgrade` runs the 0.5.0 `auth-package` codemod, which moves unchanged files and reports customised ones.

### Patch Changes

- Updated dependencies [fa60688]
  - @tatara/cli@0.5.0

## 0.4.0

### Minor Changes

- 6fac954: Generated apps use the new `@tatara/db` (`newId`, `defineSeed`, per-driver admin helpers and per-ORM `migrateDatabase` in sub-paths) and `@tatara/testing` (in-process API `client`, one database per test worker). `src/core/db/admin.ts` and `migrate.ts` become one-line re-exports naming the app's driver. `app.ts` only contains the OpenAPI and error-message callbacks when a feature needs them. `tatara upgrade` moves existing apps over (codemod `db-testing`).

### Patch Changes

- Updated dependencies [6fac954]
  - @tatara/cli@0.4.0

## 0.3.0

### Minor Changes

- 23bec93: Generated apps use the new `@tatara/http` package (`createApp`, `mountRoutes`, `serveOpenApi`, `handleErrors`, `startServer`, errors and the response envelope) instead of copied files; `app.ts` stays in the app as short, plain-Hono wiring. Browser clients can read better-auth's `set-auth-token` header. `tatara upgrade` moves existing apps onto it (codemod `http-package`).

### Patch Changes

- Updated dependencies [23bec93]
  - @tatara/cli@0.3.0
