# @tatara/db

Part of [tatara](https://github.com/mohammed-bageri/tatara). Ids, seeds, database error
helpers, migration status, per-driver admin, `explain` and a REPL.

| Import | What |
|---|---|
| `@tatara/db` | `newId`, `defineSeed`, error helpers, `drizzleMigrationStatus` |
| `@tatara/db/postgres` · `/mariadb` · `/mysql2` | `ensureDatabase`, `dropAllTables`, `truncateAllTables`; `explain`, `explainText` (Postgres) |
| `@tatara/db/prisma` · `/drizzle-postgres` · `/drizzle-mysql` | `migrateDatabase`; `appliedMigrations`, `migrationStatus` (Drizzle) |
| `@tatara/db/commands` | `dbCommands`: `db:migrate`, `db:reset`, `db:seed`, `db:migration-status` |
| `@tatara/db/tinker` | `tinkerCommand`, `startTinker`, `loadServices`, `drizzleOperators` |

## Errors

```ts
import { isUniqueViolation, likePattern, redactDbQueryErrors, retryOnceOnTxConflict } from "@tatara/db";

if (isUniqueViolation(err, "users_email_unique")) throw new ConflictError("Email taken");
await retryOnceOnTxConflict(() => db.transaction(...)); // deadlock / serialization failure
db.select().from(users).where(ilike(users.name, likePattern(search)));
pino({ serializers: { err: (e) => pino.stdSerializers.err(redactDbQueryErrors(e) as Error) } });
```

`extractDbError` reads Postgres SQLSTATEs, MySQL `code`/`errno` (key name from the message) and
Prisma `P2002`'s `meta.target`, on the error or down its `cause` chain. `redactDbQueryErrors`
replaces Drizzle query errors (SQL params in the message) with a sanitised view, and drops
Postgres `detail`/`where` and the MySQL drivers' `sql`. A MySQL message itself (`Duplicate entry
'…'`) still quotes the value.

## Migration status and tinker

```ts
// src/core/db/migrate.ts in a Drizzle app; `tatara sync` passes migrationStatus to dbCommands
// when this file exports it, which adds db:migration-status
export { migrateDatabase, migrationStatus } from "@tatara/db/drizzle-postgres";
```

```ts
import { tinkerCommand, loadServices, drizzleOperators } from "@tatara/db/tinker";
import * as orm from "drizzle-orm";

export default tinkerCommand({
	context: async () => ({ db, ...schema, ...drizzleOperators(orm), services: await loadServices() }),
	prompt: "app> ",
	onExit: () => closeDatabase(),
});
```

`explain(pool, query, { analyze })` takes any Drizzle query or `sql` object; `analyze` runs the
statement, so it writes on INSERT/UPDATE/DELETE.
