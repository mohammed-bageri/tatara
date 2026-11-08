import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationStatus {
	tag: string;
	applied: boolean;
	appliedAt: string | null;
}

export interface MigrationStatusReport {
	statuses: MigrationStatus[];
	appliedCount: number;
	pendingCount: number;
}

/** A row of Drizzle's `__drizzle_migrations`: sha256 of the SQL file, and the journal `when` (epoch ms). */
export interface AppliedMigration {
	hash: string;
	createdAt: number;
}

/**
 * Applied vs pending for every migration in `<folder>/meta/_journal.json`. A migration counts as
 * applied when its SQL file's hash or its journal `when` was recorded: the hash identifies it
 * even after a `when` was corrected in the journal.
 */
export function drizzleMigrationStatus(
	folder: string,
	applied: readonly AppliedMigration[],
): MigrationStatusReport {
	const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
		entries?: { idx: number; tag: string; when: number }[];
	};
	const byHash = new Map(applied.map((m) => [m.hash, m.createdAt]));
	const whens = new Set(applied.map((m) => m.createdAt));
	const statuses = [...(journal.entries ?? [])]
		.sort((a, b) => a.idx - b.idx)
		.map((entry): MigrationStatus => {
			const file = join(folder, `${entry.tag}.sql`);
			const hash = existsSync(file)
				? createHash("sha256").update(readFileSync(file, "utf8")).digest("hex")
				: undefined;
			const at = (hash && byHash.get(hash)) ?? (whens.has(entry.when) ? entry.when : undefined);
			return {
				tag: entry.tag,
				applied: at !== undefined,
				appliedAt: at === undefined ? null : new Date(at).toISOString(),
			};
		});
	const appliedCount = statuses.filter((s) => s.applied).length;
	return { statuses, appliedCount, pendingCount: statuses.length - appliedCount };
}
