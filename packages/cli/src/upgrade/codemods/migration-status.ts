import { versionOf } from "../../paths.ts";
import type { Codemod } from "../codemods.ts";

const PATH = "src/core/db/migrate.ts";

/** Drizzle apps re-export the driver's migrationStatus, which gives them `db:migration-status`. */
export const migrationStatus: Codemod = {
	version: "0.22.0",
	id: "migration-status",
	description: "db:migration-status for Drizzle apps (migrate.ts re-exports migrationStatus)",
	async run(ctx) {
		if (ctx.project.config.orm !== "drizzle") return;
		const text = await ctx.read(PATH).catch(() => undefined);
		if (text === undefined || /\bmigrationStatus\b/.test(text)) return;
		await ctx.addDependency("@tatara/db", versionOf("@tatara/db"));
		if (await ctx.baseline.isUnchanged(PATH, text)) await ctx.regenerate(PATH);
		else
			ctx.report.notes.push(
				`${PATH} is customised and was kept: export migrationStatus from @tatara/db/drizzle-${ctx.project.config.database === "postgres" ? "postgres" : "mysql"} there to get db:migration-status.`,
			);
	},
};
