---
"@tatara/db": minor
"@tatara/cli": minor
---

Every Drizzle app gets `db:migration-status`. `@tatara/db/drizzle-postgres` and `/drizzle-mysql` export `migrationStatus(url)`, the scaffolded `src/core/db/migrate.ts` re-exports it, and `tatara sync` passes it to `dbCommands` when that file exports it (manifest args listed under `optional` are passed only when exported). `tatara upgrade` adds it to an unchanged `src/core/db/migrate.ts` in existing Drizzle apps.
