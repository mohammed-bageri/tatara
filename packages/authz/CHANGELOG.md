# @tatara/authz

## 0.10.1

### Patch Changes

- e3b78b2: 4xx errors take `(message?, { code?, details? })`: a specific code for the client (translated as `errors.<code>`), and details. NotFoundError's argument is its message now ("Job not found"); `tatara upgrade` rewrites existing calls (0.21 codemod). `realtime.attach(server, { channels, checkPermission, featureAllowed })` takes the channel checks, for apps whose authz lives in a module.
- Updated dependencies [e3b78b2]
  - @tatara/http@0.4.0
  - @tatara/auth@0.3.2

## 0.10.0

### Minor Changes

- a87e93e: Core holds no tables: new apps keep authz and events in src/modules/authz and src/modules/events, and `tatara upgrade` moves existing apps there (0.20 codemod). `tatara check` lets a module import another module's tables (db/) as well as its services. `createI18n({ searchNamespaces: true })` finds a key without a namespace inside every namespace, so modules own their error strings. `tatara new --help` lists every add-on.

## 0.9.3

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.
- Updated dependencies [9b9ac7f]
  - @tatara/auth@0.3.1
  - @tatara/cache@0.2.1
  - @tatara/core@0.2.1
  - @tatara/db@0.3.2
  - @tatara/http@0.3.1

## 0.9.2

### Patch Changes

- Updated dependencies [22e28a7]
- Updated dependencies [1882c35]
- Updated dependencies [1882c35]
  - @tatara/auth@0.3.0
  - @tatara/core@0.2.0
  - @tatara/http@0.3.0
  - @tatara/db@0.3.1

## 0.9.1

### Patch Changes

- Updated dependencies [279dda4]
- Updated dependencies [279dda4]
  - @tatara/db@0.3.0
  - @tatara/http@0.2.0
  - @tatara/auth@0.2.2

## 0.9.0

### Minor Changes

- 1869750: Roles carry `labels`, their name and description in other languages (`{ ar: { name, description } }`), on custom roles and built-in ones (`systemRoles[].labels`, kept in sync). New authz tables get a nullable `labels` column; existing tables work without it until an app passes labels. `addOverlay` now checks `canHoldRoles` too.

## 0.8.0

### Minor Changes

- 6d7fa58: `syncSystemRoles` keeps a built-in role the code no longer has while a member still holds it (reported in `kept`, and `authz:sync-permissions` warns) instead of deleting it with that member's access. Stores implement `roleAssignmentCount(roleId)` (drizzle, prisma and memory do); a custom `AuthzStore` must add it.

## 0.7.0

### Minor Changes

- 0d5bd1a: Member and role operations apps had to write themselves:
  - `setMemberRoles` replaces a member's roles, writing and auditing only the difference, in one step.
  - `addRolesToMembers` adds roles to many members and reports the ones skipped.
  - `duplicateRole` copies a built-in or custom role.
  - `listUsersWithPermission` lists everyone a check would allow, read at decision time. It can take the caller's transaction, and needs the new `listMembers` option when a members-held role grants the permission.
  - `listAudit` pages with a cursor.
  - `syncSystemRoles` also deletes built-in roles the code no longer has, and reports them in `deleted`.
  - `createAuthz({ canHoldRoles })` lets the app refuse users who may not hold org roles.
  - `authzPlugin({ creatorRole })` takes several roles.
  
  `AuthzStore` gains `replaceMemberRoles` and `permissionHolders`, and `listAudit` takes a cursor. The drizzle, prisma and memory stores implement them; a custom store must add them.
- cfa034f: The shared permission cache invalidates correctly across processes: a cached set is keyed by a global, org, member-in-org and member version together, so `invalidateAll` reaches every process (it used to bump only orgs this process had cached) and a member's own bumps no longer mask an org-wide one (the key took the larger of two counters). `invalidateMember(userId)` without an org reaches other processes too. A failing shared cache never fails a check or a change: `onCacheError` reports it and the check reads the store. New `onInvalidate` option: called after every invalidation (e.g. to drop a revoked member's realtime connections).

### Patch Changes

- Updated dependencies [9f720bd]
  - @tatara/cache@0.2.0

## 0.6.0

### Minor Changes

- c0671ca: Add optional shared cache support with versioned keys
  
  The permission cache now accepts an optional `sharedCache` parameter (from `@tatara/cache`). When provided, uses versioned keys so invalidation on one process is seen by all others. A short local in-memory layer (≤1 s, configurable via `localCacheTtlMs`) absorbs hot paths. Without a shared cache, behaviour stays as today: an in-process Map with the full `cacheTtlMs`. This means invalidation only clears the local process — with several API replicas, a revoked role or overlay keeps working on the other replicas for up to `cacheTtlMs`.
  
  Breaking change: `PermissionCache` methods (`get`, `set`, `invalidateMember`, `invalidateAll`) are now async and return `Promise`.

### Patch Changes

- Updated dependencies [c0671ca]
  - @tatara/http@0.1.5

## 0.5.2

### Patch Changes

- 03d1428: `authzPlugin`: someone invited as `owner` gets the creator's role when they accept.

## 0.5.1

### Patch Changes

- 96f8522: `authzPlugin`: owners hold the creator's role. A member made `owner` later gets it, and an owner made `member` loses it. Authz roles given to someone who was never owner are left alone.

## 0.5.0

### Minor Changes

- d9f9578: Org access belongs to authz; better-auth's member role is membership only.
  
  - `authzPlugin(authz, options)` from `@tatara/authz/better-auth`: the creator of an org gets `admin`, a member removed or leaving loses their authz access, member roles are kept to `owner` and `member`, and `endpoints` puts better-auth's org endpoints behind authz permissions. Generated apps guard the member and invitation lists with `member:read`.
  - **Breaking:** built-in roles no longer follow better-auth's member role or user role. `SystemRole.heldBy` says who holds a role without an assignment: `"members"` (every member of the org) or `"identity"` (holders of that identity-provider role, e.g. `staff` or Keycloak roles). An org member's better-auth role `admin` no longer grants authz's `admin`.
  - `tatara upgrade` (0.13.0) adds `heldBy` to `member`, `staff`, and, in Keycloak apps, every role; it says how to move `auth.ts` to `authzPlugin`.

## 0.4.0

### Minor Changes

- 0d778b3: `authz.grantSystemRole(orgId, userId, key)`; generated apps with organizations make an org's creator its `admin` in their own `auth.ts` (and `authzOrganizationHooks` takes `creatorRole`). The notifier takes `allow({ userId, notification, channel, data })`, so the app decides who gets which channel. `sanitizeHtml` (`@tatara/core/html`, with `sanitize-html` installed). `tatara add <add-on…>` adds add-ons to an existing app. Observability registers in-thread ESM hooks (`module.registerHooks`) where Node has them, so Node 26 prints no deprecation; `@tatara/observability/hooks`.

### Patch Changes

- Updated dependencies [0d778b3]
  - @tatara/core@0.1.3

## 0.3.1

### Patch Changes

- 315003d: Operations. `@tatara/core`: a `deploy` command (commands with `phase: "deploy"` every deploy, `phase: "once"` once per database, recorded in a ledger; `db:migrate` runs first, `authz:sync-permissions` after), `createEncryption` (AES-256-GCM, rotatable keys), `randomCode`/`numericCode`/`randomToken`/`hashToken`/`safeEqual`, and `cleanText`/`safeUrl` with the `text()`/`url()` zod fields. `@tatara/db`: `commandLedger(url)` per driver; a Postgres reset also drops the `tatara` schema. New `@tatara/observability` and `observability` add-on: OpenTelemetry traces and metrics over OTLP/HTTP with auto-instrumentation, Hono request spans, trace ids on log lines, instrumented processes through `--import ./dist/apps/instrument.mjs`. Codemod 0.11.0 `deploy-ledger`.
- Updated dependencies [6170cca]
- Updated dependencies [315003d]
  - @tatara/http@0.1.2
  - @tatara/core@0.1.2
  - @tatara/db@0.2.2

## 0.3.0

### Minor Changes

- b0727b7: The app owns its auth. Generated apps keep auth in `src/modules/users` (built with `createAuthInstance`), compose HTTP in `src/apps/http.ts`, and with the admin add-on get a `staff` module with its own better-auth. Requests name their org (`requireOrg()`, `x-org-id`); a Keycloak token's `organization` claim decides which orgs its user may act in; authz has no default org, so single-tenant apps set `singleTenant`. `tatara upgrade` moves existing apps (codemod 0.10.0). The MySQL test reset deletes rows instead of truncating.

### Patch Changes

- Updated dependencies [b0727b7]
  - @tatara/auth@0.2.0
  - @tatara/db@0.2.1

## 0.2.0

### Minor Changes

- fd669b1: Generated apps are smaller:
  - tatara's own wiring tests no longer go into apps; the e2e matrix runs them.
  - `@tatara/authz` ships the Prisma and Drizzle stores (`prismaAuthzStore(db)`, `drizzleAuthzStore(db, tables)`).
  - The db, authz, email, storage and jobs commands and seeds come from their packages. Packages declare them in a `"tatara"` field, and `tatara sync` wires them into `src/generated`. An app's own command with the same name wins.
  
  `tatara upgrade` now bumps every `@tatara/*` dependency to this CLI's version and installs before syncing. The 0.9.0 codemods remove the copies that are no longer needed.

### Patch Changes

- Updated dependencies [fd669b1]
  - @tatara/db@0.2.0
