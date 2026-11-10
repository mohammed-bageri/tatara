# @tatara/observability

## 0.4.0

### Minor Changes

- 266cc1f: `startTelemetry({ redactPath })` hides path secrets from span names and attributes (`RedactingSpanProcessor`); an endpoint given with its `/v1/traces` path works too.

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

- fae0975: `startTelemetry({ spanProcessors })`: the app's span processors run on every span before it is exported (e.g. to redact secrets from URLs).

## 0.2.0

### Minor Changes

- 0d778b3: `authz.grantSystemRole(orgId, userId, key)`; generated apps with organizations make an org's creator its `admin` in their own `auth.ts` (and `authzOrganizationHooks` takes `creatorRole`). The notifier takes `allow({ userId, notification, channel, data })`, so the app decides who gets which channel. `sanitizeHtml` (`@tatara/core/html`, with `sanitize-html` installed). `tatara add <add-on…>` adds add-ons to an existing app. Observability registers in-thread ESM hooks (`module.registerHooks`) where Node has them, so Node 26 prints no deprecation; `@tatara/observability/hooks`.

### Patch Changes

- Updated dependencies [0d778b3]
  - @tatara/core@0.1.3

## 0.1.0

### Minor Changes

- 315003d: Operations. `@tatara/core`: a `deploy` command (commands with `phase: "deploy"` every deploy, `phase: "once"` once per database, recorded in a ledger; `db:migrate` runs first, `authz:sync-permissions` after), `createEncryption` (AES-256-GCM, rotatable keys), `randomCode`/`numericCode`/`randomToken`/`hashToken`/`safeEqual`, and `cleanText`/`safeUrl` with the `text()`/`url()` zod fields. `@tatara/db`: `commandLedger(url)` per driver; a Postgres reset also drops the `tatara` schema. New `@tatara/observability` and `observability` add-on: OpenTelemetry traces and metrics over OTLP/HTTP with auto-instrumentation, Hono request spans, trace ids on log lines, instrumented processes through `--import ./dist/apps/instrument.mjs`. Codemod 0.11.0 `deploy-ledger`.

### Patch Changes

- Updated dependencies [315003d]
  - @tatara/core@0.1.2
