import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProject } from "../project/config.ts";
import { check } from "./check.ts";

function app(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "tatara-check-"));
	const all: Record<string, string> = {
		"package.json": JSON.stringify({ name: "app" }),
		"tatara.json": JSON.stringify({
			version: "0.19.0",
			name: "app",
			orm: "drizzle",
			database: "postgres",
			auth: "none",
			authMethods: [],
			addons: [],
			packageManager: "npm",
		}),
		...files,
	};
	for (const [path, content] of Object.entries(all)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return loadProject(root);
}

const rules = async (files: Record<string, string>) =>
	(await check(app(files))).map((v) => `${v.file} ${v.rule}`);

describe("check: module boundaries", () => {
	it("lets a module use another's services and tables", async () => {
		expect(
			await rules({
				"src/modules/billing/services/invoice.service.ts":
					'import { findUser } from "#modules/users/services/user.service";\nimport { users } from "#modules/users/db/user.schema";\n',
				"src/modules/billing/db/invoice.schema.ts":
					'import { users } from "#modules/users/db/user.schema";\n',
			}),
		).toEqual([]);
	});

	it("refuses another module's other folders", async () => {
		expect(
			await rules({
				"src/modules/billing/routes/invoice.routes.ts":
					'import { requireUser } from "#modules/users/middlewares";\nimport { ROLES } from "#modules/users/constants/roles";\n',
			}),
		).toEqual([
			"src/modules/billing/routes/invoice.routes.ts cross-module-imports",
			"src/modules/billing/routes/invoice.routes.ts cross-module-imports",
		]);
	});

	it("refuses core importing a module, tables included", async () => {
		expect(
			await rules({
				"src/core/db/client.ts": 'import * as s from "#modules/users/db/user.schema";\n',
			}),
		).toEqual(["src/core/db/client.ts core-imports-modules"]);
	});
});
