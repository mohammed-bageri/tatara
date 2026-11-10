import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { upgrade } from "../../commands/upgrade.ts";
import { loadProject, type Project } from "../../project/config.ts";
import { tablesInModules } from "./tables-in-modules.ts";

const AUTHZ = `import * as tables from "#core/authz/db/authz.schema";
import { SYSTEM_ROLES } from "#core/authz/system-roles";
export const authz = { tables, SYSTEM_ROLES };
`;

function app(files: Record<string, string>): Project {
	const root = mkdtempSync(join(tmpdir(), "tatara-tables-in-modules-"));
	const all: Record<string, string> = {
		"package.json": JSON.stringify({ name: "app", dependencies: {}, devDependencies: {} }),
		"tatara.json": JSON.stringify({
			version: "0.19.0",
			name: "app",
			orm: "drizzle",
			database: "postgres",
			auth: "better-auth",
			authMethods: ["orgs"],
			addons: ["authz", "events"],
			packageManager: "npm",
			generated: { cli: "0.19.0", files: {} },
		}),
		...files,
	};
	for (const [path, text] of Object.entries(all)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return loadProject(root);
}

const run = (project: Project) =>
	upgrade(project, {
		cliVersion: "0.20.0",
		codemods: [tablesInModules],
		baseline: { isUnchanged: async () => false },
		runSync: async () => {},
		runInstall: async () => {},
		formatFile: async () => {},
	});
const read = (project: Project, path: string) => readFileSync(join(project.root, path), "utf8");

describe("tables-in-modules", () => {
	it("moves authz and events into modules, the app's edits included, and rewrites imports", async () => {
		const project = app({
			"src/core/authz/index.ts": AUTHZ,
			"src/core/authz/system-roles.ts": 'export const SYSTEM_ROLES = [{ key: "teacher" }];\n',
			"src/core/authz/db/authz.schema.ts": "export const authzRoles = {};\n",
			"src/core/events/index.ts": "export const events = {};\n",
			"src/core/events/schedules/relay.ts":
				'import { events } from "#core/events/index";\nexport default events;\n',
			"src/modules/notes/services/note.service.ts":
				'import { requirePermission } from "#core/authz/index";\nimport { events } from "#core/events/index";\n',
		});
		await run(project);
		expect(existsSync(join(project.root, "src/core/authz/index.ts"))).toBe(false);
		expect(existsSync(join(project.root, "src/core/events/index.ts"))).toBe(false);
		expect(read(project, "src/modules/authz/services/system-roles.ts")).toContain("teacher");
		expect(read(project, "src/modules/authz/services/authz.ts")).toBe(
			`import * as tables from "#modules/authz/db/authz.schema";
import { SYSTEM_ROLES } from "#modules/authz/services/system-roles";
export const authz = { tables, SYSTEM_ROLES };
`,
		);
		expect(read(project, "src/modules/events/schedules/relay.ts")).toContain(
			'from "#modules/events/services/events"',
		);
		expect(read(project, "src/modules/notes/services/note.service.ts")).toBe(
			'import { requirePermission } from "#modules/authz/services/authz";\nimport { events } from "#modules/events/services/events";\n',
		);
	});

	it("moves nothing when a destination is already taken", async () => {
		const project = app({
			"src/core/authz/index.ts": AUTHZ,
			"src/modules/authz/services/authz.ts": "export const other = 1;\n",
		});
		const report = await run(project);
		expect(report.blocked).toContain("tables-in-modules");
		expect(read(project, "src/core/authz/index.ts")).toBe(AUTHZ);
	});
});
