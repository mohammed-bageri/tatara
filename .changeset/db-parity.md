---
"@tatara/db": minor
---

`@tatara/db`: database error helpers — `extractDbError` (code / errno / constraint from Postgres, MySQL, Drizzle-wrapped and Prisma errors), `isUniqueViolation(err, constraint?)`, `isRetryableTxConflict`, `retryOnceOnTxConflict`, `likePattern`, and query-error redaction for logs (`isDbQueryError`, `sanitizeDbQueryError`, `redactDbQueryErrors`). `drizzleMigrationStatus(folder, applied)` with `appliedMigrations(url)` in `/drizzle-postgres` and `/drizzle-mysql`, and an optional `migrationStatus` for `dbCommands` that adds `db:migration-status`. `explain` / `explainText` in `/postgres`. New `@tatara/db/tinker`: `tinkerCommand`, `startTinker`, `discoverServiceFiles`, `loadServices`, `drizzleOperators`.
