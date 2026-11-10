# @tatara/storage

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

- cc4e9e4: `Storage` gains `uploadUrl(key, { contentType, contentLength, expiresInSeconds })` (signed PUT bound to the declared type and length), `url(key, { responseContentType, responseContentDisposition, expiresInSeconds })` (a bare number still works), `list(prefix)`, `copy(from, to)` and an optional `ensureBucket()`; `delete` of a missing object succeeds. New: a native GCS driver (`@tatara/storage/gcs`, `@google-cloud/storage` as an optional peer), `s3ClientConfig({ provider: "s3" | "minio" | "oci" | "gcs", ... })` presets, `presignClient` for a public signing endpoint, `uploadKeys` over app-declared upload contexts, `sanitizeFileName`, `publicUrl`, `organizationIdFromKey`, upload validation (`validateFileUpload`, `MIME_TYPE_MAP`, `contentDispositionFor`, ...), and orphan reconciliation over an app's `StorageObjectStore` (`findOrphanObjects`, `reconcileOrphanObjects`, `reconcileOrphanObjectsCommand`). `storage:check` now also signs a URL, cleans up on failure, and needs only `storage` from the app.

## 0.2.0

### Minor Changes

- fd669b1: Generated apps are smaller:
  - tatara's own wiring tests no longer go into apps; the e2e matrix runs them.
  - `@tatara/authz` ships the Prisma and Drizzle stores (`prismaAuthzStore(db)`, `drizzleAuthzStore(db, tables)`).
  - The db, authz, email, storage and jobs commands and seeds come from their packages. Packages declare them in a `"tatara"` field, and `tatara sync` wires them into `src/generated`. An app's own command with the same name wins.
  
  `tatara upgrade` now bumps every `@tatara/*` dependency to this CLI's version and installs before syncing. The 0.9.0 codemods remove the copies that are no longer needed.
