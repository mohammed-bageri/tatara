/**
 * @tatara/db: ids, seeds, database error helpers and migration status. Driver helpers live in
 * sub-paths so an app loads only its own: `@tatara/db/postgres` | `/mariadb` | `/mysql2`
 * (ensureDatabase, dropAllTables, truncateAllTables; explain on Postgres) and
 * `@tatara/db/prisma` | `/drizzle-postgres` | `/drizzle-mysql` (migrateDatabase), plus
 * `@tatara/db/tinker` (a REPL command).
 */
export {
	type DbErrorInfo,
	type DbQueryError,
	extractDbError,
	isDbQueryError,
	isRetryableTxConflict,
	isUniqueViolation,
	likePattern,
	redactDbQueryErrors,
	retryOnceOnTxConflict,
	type SanitizedDbQueryError,
	sanitizeDbQueryError,
} from "./errors.ts";
export { newId } from "./id.ts";
export {
	type AppliedMigration,
	drizzleMigrationStatus,
	type MigrationStatus,
	type MigrationStatusReport,
} from "./migration-status.ts";
export { defineSeed, type SeedDefinition } from "./seed.ts";
