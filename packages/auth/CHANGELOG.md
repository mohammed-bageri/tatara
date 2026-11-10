# @tatara/auth

## 0.6.1

### Patch Changes

- Updated dependencies [60bffa9]
  - @tatara/http@0.7.0

## 0.6.0

### Minor Changes

- a15c818: `currentOrgId(c)` gives the org the request acts in. `requireOrg` answers a non-member 403 `NOT_ORG_MEMBER` (was `FORBIDDEN`), so clients can tell it from a missing permission; the i18n template translates it.

## 0.5.0

### Minor Changes

- 617cd51: A session principal's `claims` hold the session user (email, name, the app's additional user fields), so routes read them without another query.

## 0.4.0

### Minor Changes

- 7f7c89f: `createApp({ redactPath })` hides path secrets from the request log. `requireOrg({ cookie })` falls back to a cookie when the header is missing. `requirePermission` answers 403 `PERMISSION_DENIED` with `details.permission` (was `FORBIDDEN`); the i18n template translates it.

### Patch Changes

- Updated dependencies [7f7c89f]
  - @tatara/http@0.6.0

## 0.3.3

### Patch Changes

- Updated dependencies [cbe1757]
  - @tatara/http@0.5.0

## 0.3.2

### Patch Changes

- Updated dependencies [e3b78b2]
  - @tatara/http@0.4.0

## 0.3.1

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.
- Updated dependencies [9b9ac7f]
  - @tatara/core@0.2.1
  - @tatara/http@0.3.1

## 0.3.0

### Minor Changes

- 22e28a7: `createAuthInstance` options `clientIp` (`{ resolve, header?, unresolved? }`: better-auth's rate limits and session IPs key on the address the app resolved, set by the new `handleRequest(c)`) and `onUnauthorized`; it also returns `attachSession` (`c.var.session` / `c.var.user`) and `requireSession` (401 without a user or while an admin-plugin ban holds). New exports `isBannedNow`, `withClientIpHeader`, `SessionEnv`, `ClientIpOptions`.
  
  `sessionPrincipal` (so `attachPrincipal`, `requireAuth()` and `requireOrg()`) no longer gives a principal to a user whose admin-plugin ban is in force.

### Patch Changes

- Updated dependencies [1882c35]
- Updated dependencies [1882c35]
  - @tatara/core@0.2.0
  - @tatara/http@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [279dda4]
  - @tatara/http@0.2.0

## 0.2.1

### Patch Changes

- 68e4f61: `requireOrg({ param: "orgId" })` takes the org from the path (`/orgs/:orgId/...`); a header can't override it.

## 0.2.0

### Minor Changes

- b0727b7: The app owns its auth. Generated apps keep auth in `src/modules/users` (built with `createAuthInstance`), compose HTTP in `src/apps/http.ts`, and with the admin add-on get a `staff` module with its own better-auth. Requests name their org (`requireOrg()`, `x-org-id`); a Keycloak token's `organization` claim decides which orgs its user may act in; authz has no default org, so single-tenant apps set `singleTenant`. `tatara upgrade` moves existing apps (codemod 0.10.0). The MySQL test reset deletes rows instead of truncating.

## 0.1.1

### Patch Changes

- b9ff8c7: `tatara eject <package> [--with-dependents]` copies a package's source into `src/ejected/<name>` and points the app's imports at it. After that, `tatara upgrade`, `sync` and the generators use the app's copy. Library packages now ship their `src` (without tests), so they can be ejected.
- Updated dependencies [b9ff8c7]
  - @tatara/core@0.1.1
  - @tatara/http@0.1.1
