import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { upgrade } from "../../commands/upgrade.ts";
import { loadProject, type Project } from "../../project/config.ts";
import { hashContent } from "../../project/hashes.ts";
import { migrationStatus } from "./migration-status.ts";

const OLD_MIGRATE = 'export { migrateDatabase } from "@tatara/db/drizzle-postgres";\n';

function app(migrate: string, orm = "drizzle"): Project {
	const root = mkdtempSync(join(tmpdir(), "tatara-migration-status-"));
	const files: Record<string, string> = {
		"package.json": JSON.stringify({
			name: "app",
			dependencies: { "@tatara/db": "^0.3.0" },
			devDependencies: {},
		}),
		"tatara.json": JSON.stringify({
			version: "0.21.0",
			name: "app",
			orm,
			database: "postgres",
			auth: "none",
			authMethods: [],
			addons: [],
			packageManager: "pnpm",
			generated: { cli: "0.21.0", files: { "src/core/db/migrate.ts": hashContent(OLD_MIGRATE) } },
		}),
		"src/core/db/migrate.ts": migrate,
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return loadProject(root);
}

const run = (project: Project) =>
	upgrade(project, {
		cliVersion: "0.22.0",
		codemods: [migrationStatus],
		baseline: {
			async isUnchanged(path, content) {
				return project.config.generated?.files[path] === hashContent(content);
			},
		},
		runSync: async () => {},
		runInstall: async () => {},
		formatFile: async () => {},
	});
const read = (project: Project, path: string) => readFileSync(join(project.root, path), "utf8");

describe("0.22.0 migration-status codemod", () => {
	it("regenerates an unchanged migrate.ts with migrationStatus", async () => {
		const project = app(OLD_MIGRATE);
		await run(project);
		expect(read(project, "src/core/db/migrate.ts")).toBe(
			'export { migrateDatabase, migrationStatus } from "@tatara/db/drizzle-postgres";\n',
		);
	});

	it("changes nothing when migrate.ts already exports migrationStatus (a second run)", async () => {
		const done =
			'export { migrateDatabase, migrationStatus } from "@tatara/db/drizzle-postgres";\n';
		const project = app(done);
		const report = await run(project);
		expect(read(project, "src/core/db/migrate.ts")).toBe(done);
		expect(report.notes).toEqual([]);
	});

	it("keeps a customised migrate.ts and says what to export", async () => {
		const custom = `${OLD_MIGRATE}// ours\n`;
		const project = app(custom);
		const report = await run(project);
		expect(read(project, "src/core/db/migrate.ts")).toBe(custom);
		expect(report.notes.join("\n")).toContain(
			"export migrationStatus from @tatara/db/drizzle-postgres",
		);
	});

	it("leaves a Prisma app alone", async () => {
		const prisma = 'export { migrateDatabase } from "@tatara/db/prisma";\n';
		const project = app(prisma, "prisma");
		await run(project);
		expect(read(project, "src/core/db/migrate.ts")).toBe(prisma);
	});
});
