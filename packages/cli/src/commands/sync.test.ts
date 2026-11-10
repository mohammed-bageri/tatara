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

	it('imports a package\'s argument from where tatara.json "paths" says the app keeps it', async () => {
		const root = app({});
		const config = JSON.parse(readFileSync(join(root, "tatara.json"), "utf8"));
		writeFileSync(
			join(root, "tatara.json"),
			JSON.stringify({ ...config, paths: { "#core/email/send": "#modules/email/send" } }),
		);
		await sync(loadProject(root));
		const text = generated(root, "commands.ts");
		expect(text).toContain('import { sendEmail } from "#modules/email/send";');
		expect(text).not.toContain('"#core/email/send"');
		// arguments with no entry keep the package's default
		expect(text).toContain('import { env } from "#core/config/env";');
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

describe("sync: events", () => {
	it("lists event definitions and subscribers from core and modules", async () => {
		const root = app({
			"package.json": JSON.stringify({ name: "app", dependencies: {} }),
			"tatara.json": JSON.stringify({
				version: "0.14.0",
				name: "app",
				orm: "drizzle",
				database: "postgres",
				auth: "none",
				authMethods: [],
				addons: ["events", "jobs", "cache"],
				packageManager: "pnpm",
			}),
			"src/core/audit/events/login.ts": "export default {};\n",
			"src/modules/billing/events/invoice.ts": "export default [];\n",
			"src/modules/billing/events/invoice.test.ts": "",
			"src/modules/billing/event-subscribers/send-receipt.ts": "export default {};\n",
		});
		await sync(loadProject(root));
		const events = generated(root, "events.ts");
		expect(events).toContain('import event_core_audit_login from "#core/audit/events/login";');
		expect(events).toContain(
			'import event_modules_billing_invoice from "#modules/billing/events/invoice";',
		);
		expect(events).toContain(
			"export const events = [event_core_audit_login, event_modules_billing_invoice].flat() satisfies readonly EventDefinition[];",
		);
		expect(events).toContain("export type EventPayloads = EventPayloadsOf<typeof events>;");
		expect(events).not.toContain("invoice.test");
		expect(generated(root, "subscribers.ts")).toContain(
			'import subscriber_modules_billing_send_receipt from "#modules/billing/event-subscribers/send-receipt";',
		);
	});

	it("writes no event lists without the add-on", async () => {
		const root = app({ "src/modules/billing/events/invoice.ts": "export default {};\n" });
		await sync(loadProject(root));
		expect(existsSync(join(root, "src/generated/events.ts"))).toBe(false);
	});
});

describe("sync: app-declared registries", () => {
	function registryApp(registries: object[], files: Record<string, string>) {
		const root = app({
			"package.json": JSON.stringify({
				name: "app",
				type: "module",
				imports: { "#*": "./src/*.ts" },
				dependencies: {},
			}),
			...files,
		});
		const config = JSON.parse(readFileSync(join(root, "tatara.json"), "utf8"));
		writeFileSync(join(root, "tatara.json"), JSON.stringify({ ...config, registries }));
		return root;
	}

	it("lists a named export of every matched file, typed, core before modules", async () => {
		const root = registryApp(
			[
				{
					name: "approvalSubjects",
					glob: ["src/modules/*/approval-subjects/*.ts", "src/core/*/approval-subjects/*.ts"],
					export: "subject",
					type: { import: "#modules/approvals/subjects", name: "ApprovalSubject" },
				},
			],
			{
				"src/modules/offers/approval-subjects/offer.ts": "export const subject = {};\n",
				"src/modules/offers/approval-subjects/offer.test.ts": "",
				"src/core/audit/approval-subjects/log.ts": "export const subject = {};\n",
			},
		);
		await sync(loadProject(root));
		expect(generated(root, "approvalSubjects.ts")).toBe(
			`// Generated by \`tatara sync\` — do not edit.
import type { ApprovalSubject } from "#modules/approvals/subjects";
import { subject as approvalSubjects_0 } from "#core/audit/approval-subjects/log";
import { subject as approvalSubjects_1 } from "#modules/offers/approval-subjects/offer";

export const approvalSubjects: ApprovalSubject[] = [approvalSubjects_0, approvalSubjects_1];
`,
		);
	});

	it("imports the default export or the module namespace", async () => {
		const root = registryApp(
			[
				{ name: "slices", glob: "src/modules/*/entitlements/index.ts", export: "*" },
				{ name: "plain", glob: "src/modules/*/plain/*.ts" },
			],
			{
				"src/modules/billing/entitlements/index.ts": "export const features = [];\n",
				"src/modules/billing/plain/a.ts": "export default 1;\n",
			},
		);
		await sync(loadProject(root));
		expect(generated(root, "slices.ts")).toContain(
			'import * as slices_0 from "#modules/billing/entitlements/index";',
		);
		expect(generated(root, "slices.ts")).toContain("export const slices = [slices_0] as const;");
		expect(generated(root, "plain.ts")).toContain(
			'import plain_0 from "#modules/billing/plain/a";',
		);
	});

	it("spreads array exports, types record exports, and lists owners for entries", async () => {
		const root = registryApp(
			[
				{
					name: "namespaces",
					glob: "src/modules/*/i18n/namespaces.ts",
					export: "namespaces",
					each: "array",
					type: { name: "string" },
				},
				{
					name: "uploadContexts",
					glob: "src/modules/*/storage/upload-contexts.ts",
					export: "uploadContexts",
					each: "record",
					type: { import: "#modules/files/registry", name: "Handler" },
				},
				{
					name: "workItemSources",
					glob: "src/modules/*/work-item-sources/index.ts",
					export: "workItemSources",
					each: "array",
					shape: "entries",
					type: { import: "#modules/work-items/sources", name: "WorkItemSource" },
				},
			],
			{
				"src/modules/user/i18n/namespaces.ts": 'export const namespaces = ["auth"] as const;\n',
				"src/modules/user/storage/upload-contexts.ts": "export const uploadContexts = {};\n",
				"src/modules/approvals/work-item-sources/index.ts": "export const workItemSources = [];\n",
			},
		);
		await sync(loadProject(root));
		expect(generated(root, "namespaces.ts")).toContain(
			"export const namespaces: string[] = [...namespaces_0];",
		);
		expect(generated(root, "namespaces.ts")).not.toContain("import type");
		expect(generated(root, "uploadContexts.ts")).toContain(
			"export const uploadContexts: Record<string, Handler>[] = [uploadContexts_0];",
		);
		expect(generated(root, "workItemSources.ts")).toContain(
			`export const workItemSources: { owner: string; file: string; value: readonly WorkItemSource[] }[] = [
	{ owner: "module:approvals", file: "src/modules/approvals/work-item-sources/index.ts", value: workItemSources_0 },
];`,
		);
	});

	it("writes an empty typed list when nothing matches", async () => {
		const root = registryApp(
			[{ name: "guards", glob: "src/modules/*/delete-guards/*.ts", type: { name: "string" } }],
			{},
		);
		await sync(loadProject(root));
		expect(generated(root, "guards.ts")).toContain("export const guards: string[] = [];");
	});

	it("throws at load when two items share the unique field, naming both owners", async () => {
		const root = registryApp(
			[
				{
					name: "nodes",
					glob: "src/modules/*/automation-nodes/*.ts",
					export: "nodes",
					each: "array",
					shape: "entries",
					unique: "kind",
				},
				{ name: "subjects", glob: "src/modules/*/subjects/*.ts", unique: "type" },
			],
			{
				"src/modules/a/automation-nodes/x.ts": 'export const nodes = [{ kind: "wait" }];\n',
				"src/modules/b/automation-nodes/y.ts":
					'export const nodes = [{ kind: "send" }, { kind: "wait" }];\n',
				"src/modules/a/subjects/one.ts": 'export default { type: "offer" };\n',
				"src/modules/b/subjects/two.ts": 'export default { type: "join" };\n',
			},
		);
		await sync(loadProject(root));
		await expect(import(join(root, "src/generated/nodes.ts"))).rejects.toThrow(
			'Duplicate nodes kind "wait" (module:a and module:b)',
		);
		const { subjects } = await import(join(root, "src/generated/subjects.ts"));
		expect(subjects).toEqual([{ type: "offer" }, { type: "join" }]);
	});

	it.each([
		[{ name: "routes", glob: "x" }, /already writes/],
		[{ name: "not-an-identifier", glob: "x" }, /identifier/],
		[{ name: "a", glob: [] }, /glob is empty/],
		[{ name: "a", glob: "x", export: "a.b" }, /export must be/],
		[{ name: "a", glob: "x", each: "record", unique: "k" }, /not to "record"/],
	])("refuses a registry it can't generate: %j", async (registry, message) => {
		const root = registryApp([registry], {});
		await expect(sync(loadProject(root))).rejects.toThrow(message);
	});

	it("refuses two registries with one name", async () => {
		const root = registryApp(
			[
				{ name: "a", glob: "x" },
				{ name: "a", glob: "y" },
			],
			{},
		);
		await expect(sync(loadProject(root))).rejects.toThrow(/declared twice/);
	});
});
