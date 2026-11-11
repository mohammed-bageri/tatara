import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProject } from "../project/config.ts";
import { check } from "./check.ts";

function app(files: Record<string, string>, config: Record<string, unknown> = {}) {
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
			...config,
		}),
		...files,
	};
	for (const [path, content] of Object.entries(all)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return loadProject(root);
}

const rules = async (files: Record<string, string>, config?: Record<string, unknown>) =>
	(await check(app(files, config))).map((v) => `${v.file}:${v.line} ${v.rule}`);

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

	it("lets a module subscribe to another's domain events", async () => {
		expect(
			await rules({
				"src/modules/billing/event-subscribers/user-created.ts":
					'import { userCreated } from "#modules/users/events/user";\n',
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
			"src/modules/billing/routes/invoice.routes.ts:1 cross-module-imports",
			"src/modules/billing/routes/invoice.routes.ts:2 cross-module-imports",
		]);
	});

	it("refuses core importing a module, tables included", async () => {
		expect(
			await rules({
				"src/core/db/client.ts": 'import * as s from "#modules/users/db/user.schema";\n',
			}),
		).toEqual(["src/core/db/client.ts:1 core-imports-modules"]);
	});
});

describe("check: parent imports", () => {
	it("refuses ../ in side-effect imports, vi.mock and vi.importActual", async () => {
		expect(
			await rules({
				"src/modules/billing/tests/invoice.test.ts": [
					'import "../services/setup";',
					'vi.mock("../services/invoice.service");',
					'const real = await vi.importActual<typeof import("#modules/billing/services/invoice.service")>("../services/invoice.service");',
					'vi.mock("#modules/billing/services/invoice.service");',
					'import "./local";',
				].join("\n"),
			}),
		).toEqual([
			"src/modules/billing/tests/invoice.test.ts:2 no-parent-imports",
			"src/modules/billing/tests/invoice.test.ts:3 no-parent-imports",
			"src/modules/billing/tests/invoice.test.ts:1 no-parent-imports",
		]);
	});
});

describe("check: tests location", () => {
	it("accepts tests under a module's tests/ folder and the top-level tests/", async () => {
		expect(
			await rules({
				"src/modules/billing/tests/invoice.test.ts": "",
				"src/modules/billing/tests/services/total.test.ts": "",
				"src/core/http/tests/routes.test.ts": "",
				"tests/smoke.test.ts": "",
			}),
		).toEqual([]);
	});

	it("refuses a test next to the code", async () => {
		expect(
			await rules({
				"src/modules/billing/services/invoice.test.ts": "",
				"src/core/http/routes.test.ts": "",
			}),
		).toEqual([
			"src/core/http/routes.test.ts:1 tests-location",
			"src/modules/billing/services/invoice.test.ts:1 tests-location",
		]);
	});
});

describe("check: module folders", () => {
	it("accepts the folders tatara discovers", async () => {
		const files = Object.fromEntries(
			[
				"routes",
				"services",
				"validators",
				"db",
				"commands",
				"tests",
				"consumers",
				"schedules",
				"events",
				"event-subscribers",
				"emails",
				"notifications",
				"channels",
				"permissions",
			].map((folder) => [`src/modules/billing/${folder}/x.ts`, ""]),
		);
		expect(await rules(files)).toEqual([]);
	});

	it("refuses other folders, even with no .ts inside", async () => {
		expect(
			await rules({
				"src/modules/billing/helpers/money.ts": "",
				"src/modules/billing/assets/logo.svg": "",
				"src/modules/billing/services/invoice.service.ts": "",
			}),
		).toEqual([
			"src/modules/billing/assets/:1 module-folders",
			"src/modules/billing/helpers/:1 module-folders",
		]);
	});

	it("accepts a registry's folder, in every module or the one it names", async () => {
		const registries = [
			{ name: "widgets", glob: "src/modules/*/widgets/*.ts" },
			{ name: "nodes", glob: ["src/modules/automations/{nodes,triggers}/*.ts"] },
			{ name: "guards", glob: "src/{modules,core}/*/guards/*.ts" },
			{ name: "probes", glob: "src/core/*/probes/*.ts" },
		];
		expect(
			await rules(
				{
					"src/modules/billing/widgets/a.ts": "",
					"src/modules/automations/nodes/a.ts": "",
					"src/modules/automations/triggers/a.ts": "",
					"src/modules/billing/nodes/a.ts": "",
					"src/modules/billing/guards/a.ts": "",
					"src/modules/billing/probes/a.ts": "",
				},
				{ registries },
			),
		).toEqual([
			"src/modules/billing/nodes/:1 module-folders",
			"src/modules/billing/probes/:1 module-folders",
		]);
	});
});
