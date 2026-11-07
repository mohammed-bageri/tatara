import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProject } from "../project/config.ts";
import { sync } from "./sync.ts";

const manifest = (name: string, tatara: object) =>
	JSON.stringify({ name: `@tatara/${name}`, version: "0.1.0", tatara });

function app(files: Record<string, string>, ejected?: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "tatara-sync-"));
	const all: Record<string, string> = {
		"package.json": JSON.stringify({
			name: "app",
			dependencies: { "@tatara/db": "^0.1.0", "@tatara/email": "^0.1.0", hono: "4.13.13" },
		}),
		"tatara.json": JSON.stringify({
			version: "0.9.0",
			name: "app",
			orm: "none",
			database: "none",
			auth: "none",
			authMethods: [],
			addons: ["email"],
			packageManager: "pnpm",
			...(ejected ? { ejected } : {}),
		}),
		"node_modules/@tatara/db/package.json": manifest("db", {
			commands: [
				{
					import: "@tatara/db/commands",
					factory: "dbCommands",
					args: { env: "#core/config/env", seeds: "#generated/seeds" },
				},
			],
		}),
		"node_modules/@tatara/email/package.json": manifest("email", {
			commands: [
				{
					import: "@tatara/email/commands",
					factory: "emailCommands",
					args: { sendEmail: "#core/email/send", env: "#core/config/env" },
				},
			],
		}),
		...files,
	};
	for (const [path, text] of Object.entries(all)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

const generated = (root: string, file: string) =>
	readFileSync(join(root, "src/generated", file), "utf8");

describe("sync: commands from packages", () => {
	it("imports each package's factory and the app modules it takes, once each", async () => {
		const root = app({ "src/modules/billing/commands/close.ts": "export default {};\n" });
		await sync(loadProject(root));
		const text = generated(root, "commands.ts");
		expect(text).toContain('import { dbCommands } from "@tatara/db/commands";');
		expect(text).toContain('import { emailCommands } from "@tatara/email/commands";');
		expect(text.match(/import \{ env \} from "#core\/config\/env";/g)).toHaveLength(1);
		expect(text).toContain("...dbCommands({ env, seeds })");
		expect(text).toContain("...emailCommands({ sendEmail, env })");
		expect(text).toContain('from "#modules/billing/commands/close"');
		// the app's own command wins over a package's command with the same name
		expect(text).toContain("fromPackages.filter((c) => !own.some((o) => o.name === c.name))");
	});

	it("reads an ejected package's manifest from its copy", async () => {
		const root = app(
			{
				"src/ejected/email/tatara-package.json": JSON.stringify({
					commands: [
						{
							import: "@tatara/email/commands",
							factory: "emailCommands",
							args: { sendEmail: "#core/email/send" },
						},
					],
				}),
			},
			{ email: "0.1.0" },
		);
		await sync(loadProject(root));
		expect(generated(root, "commands.ts")).toContain(
			'import { emailCommands } from "#ejected/email/commands";',
		);
	});

	it("refuses two packages that need different modules under one name", async () => {
		const root = app({
			"node_modules/@tatara/email/package.json": manifest("email", {
				commands: [
					{
						import: "@tatara/email/commands",
						factory: "emailCommands",
						args: { env: "#core/other/env" },
					},
				],
			}),
		});
		await expect(sync(loadProject(root))).rejects.toThrow(/"env"/);
	});

	it("keeps the plain list when no package contributes", async () => {
		const root = app({
			"package.json": JSON.stringify({ name: "app", dependencies: {} }),
		});
		await sync(loadProject(root));
		expect(generated(root, "commands.ts")).toContain(
			"export const commands: CommandDefinition[] = [];",
		);
	});
});

describe("sync: seeds", () => {
	function dbApp(dependencies: Record<string, string>) {
		return app({
			"package.json": JSON.stringify({ name: "app", dependencies }),
			"tatara.json": JSON.stringify({
				version: "0.14.0",
				name: "app",
				orm: "drizzle",
				database: "postgres",
				auth: "none",
				authMethods: [],
				addons: [],
				packageManager: "pnpm",
			}),
		});
	}

	it("lists the seeds when the app runs them through @tatara/db", async () => {
		const root = dbApp({ "@tatara/db": "^0.2.0" });
		await sync(loadProject(root));
		expect(generated(root, "seeds.ts")).toContain(
			'import type { SeedDefinition } from "@tatara/db";',
		);
	});

	it("writes no seeds list for an app with a database but not @tatara/db", async () => {
		const root = dbApp({ "drizzle-orm": "^0.45.0" });
		await sync(loadProject(root));
		expect(existsSync(join(root, "src/generated/seeds.ts"))).toBe(false);
	});
});
