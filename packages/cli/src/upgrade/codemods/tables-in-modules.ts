import type { Codemod } from "../codemods.ts";
import { MOVED_IN_0_20 } from "../moves.ts";

/** Import specifiers that moved, old → new. */
const SPECIFIERS: Record<string, string> = {
	"#core/authz/index": "#modules/authz/services/authz",
	"#core/authz/system-roles": "#modules/authz/services/system-roles",
	"#core/authz/db/authz.schema": "#modules/authz/db/authz.schema",
	"#modules/users/routes/authorization.routes": "#modules/authz/routes/authorization.routes",
	"#core/events/index": "#modules/events/services/events",
	"#core/events/db/events.schema": "#modules/events/db/events.schema",
};

/**
 * Core holds no tables: authz and events (instance, tables, roles, schedules) move into
 * src/modules/authz and src/modules/events. Files move as they are, the app's edits included.
 */
export const tablesInModules: Codemod = {
	version: "0.20.0",
	id: "tables-in-modules",
	description: "Move authz and events from src/core into src/modules (core holds no tables)",
	async run(ctx) {
		const read = (path: string) => ctx.read(path).catch(() => undefined);
		// all or nothing: the moved files import each other at their new paths
		const moves: [string, string][] = [];
		const blockers: string[] = [];
		for (const [from, to] of Object.entries(MOVED_IN_0_20)) {
			const text = await read(from);
			if (text === undefined) continue;
			const there = await read(to);
			if (there !== undefined && there !== text) blockers.push(`${to} already exists`);
			else moves.push([from, to]);
		}
		if (blockers.length > 0) {
			ctx.report.notes.push(
				`authz and events were not moved into src/modules: ${blockers.join("; ")}. Move src/core/authz and src/core/events by hand (see a newly generated app), or map their old paths in tatara.json "paths".`,
			);
			ctx.report.blocked.push("tables-in-modules");
			return;
		}
		for (const [from, to] of moves) {
			const text = await read(from);
			if (text === undefined) continue;
			await ctx.write(to, text);
			await ctx.remove(from);
		}
		for (const [from, to] of Object.entries(SPECIFIERS)) await ctx.rewriteImports(from, to);
		if (moves.length > 0)
			ctx.report.notes.push(
				"authz and events now live in src/modules/authz and src/modules/events (core holds no tables). Imports were rewritten; check any docs or scripts that name the old paths.",
			);
	},
};
