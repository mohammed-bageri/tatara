# @tatara/core

## 0.2.1

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.

## 0.2.0

### Minor Changes

- 1882c35: `@tatara/core`: `createEncryption` options `active`, `format: "colon"` (WebCrypto-compatible `k<id>:<iv>:<body>`) and `legacyKey`; `isSealed`, `parseKeyRing`, `validateKeyRing`; `mapWithConcurrency`; `safeUrl` / `url` options `protocols` and `defaultProtocol`, and null input. `@tatara/core/html`: `sanitizeHtml` options (`tags`, `attributes`, `styles`, `schemes`, `imageSchemes`), null input, and `stripHtml`. New subpaths `@tatara/core/time` (civil dates and wall-clock times in a timezone) and `@tatara/core/csv` (`toCsv`, `escapeCsvCell`).

## 0.1.3

### Patch Changes

- 0d778b3: `authz.grantSystemRole(orgId, userId, key)`; generated apps with organizations make an org's creator its `admin` in their own `auth.ts` (and `authzOrganizationHooks` takes `creatorRole`). The notifier takes `allow({ userId, notification, channel, data })`, so the app decides who gets which channel. `sanitizeHtml` (`@tatara/core/html`, with `sanitize-html` installed). `tatara add <add-on…>` adds add-ons to an existing app. Observability registers in-thread ESM hooks (`module.registerHooks`) where Node has them, so Node 26 prints no deprecation; `@tatara/observability/hooks`.

## 0.1.2

### Patch Changes

- 315003d: Operations. `@tatara/core`: a `deploy` command (commands with `phase: "deploy"` every deploy, `phase: "once"` once per database, recorded in a ledger; `db:migrate` runs first, `authz:sync-permissions` after), `createEncryption` (AES-256-GCM, rotatable keys), `randomCode`/`numericCode`/`randomToken`/`hashToken`/`safeEqual`, and `cleanText`/`safeUrl` with the `text()`/`url()` zod fields. `@tatara/db`: `commandLedger(url)` per driver; a Postgres reset also drops the `tatara` schema. New `@tatara/observability` and `observability` add-on: OpenTelemetry traces and metrics over OTLP/HTTP with auto-instrumentation, Hono request spans, trace ids on log lines, instrumented processes through `--import ./dist/apps/instrument.mjs`. Codemod 0.11.0 `deploy-ledger`.

## 0.1.1

### Patch Changes

- b9ff8c7: `tatara eject <package> [--with-dependents]` copies a package's source into `src/ejected/<name>` and points the app's imports at it. After that, `tatara upgrade`, `sync` and the generators use the app's copy. Library packages now ship their `src` (without tests), so they can be ejected.
