# @tatara/keycloak

## 0.1.4

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.
- Updated dependencies [9b9ac7f]
  - @tatara/auth@0.3.1
  - @tatara/core@0.2.1

## 0.1.3

### Patch Changes

- Updated dependencies [22e28a7]
- Updated dependencies [1882c35]
  - @tatara/auth@0.3.0
  - @tatara/core@0.2.0

## 0.1.2

### Patch Changes

- b0727b7: The app owns its auth. Generated apps keep auth in `src/modules/users` (built with `createAuthInstance`), compose HTTP in `src/apps/http.ts`, and with the admin add-on get a `staff` module with its own better-auth. Requests name their org (`requireOrg()`, `x-org-id`); a Keycloak token's `organization` claim decides which orgs its user may act in; authz has no default org, so single-tenant apps set `singleTenant`. `tatara upgrade` moves existing apps (codemod 0.10.0). The MySQL test reset deletes rows instead of truncating.
- Updated dependencies [b0727b7]
  - @tatara/auth@0.2.0

## 0.1.1

### Patch Changes

- b9ff8c7: `tatara eject <package> [--with-dependents]` copies a package's source into `src/ejected/<name>` and points the app's imports at it. After that, `tatara upgrade`, `sync` and the generators use the app's copy. Library packages now ship their `src` (without tests), so they can be ejected.
- Updated dependencies [b9ff8c7]
  - @tatara/core@0.1.1
  - @tatara/auth@0.1.1
