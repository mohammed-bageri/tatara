import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { x } from "tinyexec";
import { glob } from "tinyglobby";
import { routeMountCollisions } from "../commands/route-mounts.ts";
import { applyNames, type Names, names } from "../engine/names.ts";
import { fillSlots, type SlotFill } from "../engine/slots.ts";
import { TEMPLATES_DIR } from "../paths.ts";
import { pmCommands } from "../pm.ts";
import type { Project } from "../project/config.ts";
import { ejectedPackages, pointAtEjected } from "../project/ejected.ts";

export const GENERATORS = [
	"module",
	"resource",
	"route",
	"service",
	"schema",
	"command",
	"consumer",
	"schedule",
	"workflow",
	"activity",
	"workflow-schedule",
	"permission",
] as const;

export type GeneratorKind = (typeof GENERATORS)[number];

export class GeneratorError extends Error {}

export interface GenerateRequest {
	kind: GeneratorKind;
	name: string;
	module?: string;
	dryRun?: boolean;
	/** skip `tatara sync` and formatting (used by `tatara new`, which runs them later) */
	skipPostProcess?: boolean;
}

export interface GenerateResult {
	kind: GeneratorKind;
	files: string[];
	dryRun: boolean;
}

const REQUIRES: Partial<Record<GeneratorKind, { feature: string; hint: string }>> = {
	resource: { feature: "db", hint: "it needs a database" },
	schema: { feature: "db", hint: "it needs a database" },
	consumer: { feature: "jobs", hint: "it needs the jobs add-on" },
	schedule: { feature: "jobs", hint: "it needs the jobs add-on" },
	workflow: { feature: "temporal", hint: "it needs the temporal add-on" },
	activity: { feature: "temporal", hint: "it needs the temporal add-on" },
	"workflow-schedule": { feature: "temporal", hint: "it needs the temporal add-on" },
	permission: { feature: "authz", hint: "it needs the authz add-on" },
};

const ACTIONS = {
	list: "read",
	read: "read",
	create: "create",
	update: "update",
	delete: "delete",
};

function guardSlots(project: Project, n: Names): SlotFill[] {
	const fills: SlotFill[] = [];
	const add = (slot: string, content: string) => fills.push({ slot, content, order: fills.length });
	if (project.has("authz")) {
		add("imports", 'import { requirePermission } from "#modules/authz/services/authz";');
		// with organizations, each request names the org it acts in before permissions are checked
		const orgs = project.has("auth-orgs");
		if (orgs) add("imports", 'import { requireOrg } from "#modules/users/services/auth";');
		for (const [route, action] of Object.entries(ACTIONS)) {
			const guards = `${orgs ? "requireOrg(), " : ""}requirePermission("${n.kebab}:${action}")`;
			add(
				`guard-${route}`,
				`middleware: [${guards}] as const,\nsecurity: [{ bearerAuth: ["${n.kebab}:${action}"] }],`,
			);
		}
		add("auth-errors", "...errorResponses(401, 403),");
	} else if (project.has("auth")) {
		add("imports", 'import { requireAuth } from "@tatara/auth";');
		for (const route of Object.keys(ACTIONS)) {
			add(
				`guard-${route}`,
				"middleware: [requireAuth()] as const,\nsecurity: [{ bearerAuth: [] }],",
			);
		}
		add("auth-errors", "...errorResponses(401),");
	}
	return fills;
}

function testSlots(project: Project, n: Names): SlotFill[] {
	if (!project.has("auth")) return [];
	const fills: SlotFill[] = [
		{ slot: "test-imports", content: 'import { asUser } from "#tests/helpers/auth";', order: 0 },
		{
			slot: "test-cases",
			order: 1,
			content: [
				'it("requires authentication", async () => {',
				"\tconst res = await api.get(path);",
				"\texpect(res.status).toBe(401);",
				"});",
			].join("\n"),
		},
	];
	if (project.has("authz")) {
		const permissions = ["read", "create", "update", "delete"].map((a) => `"${n.kebab}:${a}"`);
		fills.push(
			{
				slot: "test-auth",
				order: 2,
				content: `Object.assign(headers, await asUser({ permissions: [${permissions.join(", ")}] }));`,
			},
			{
				slot: "test-cases",
				order: 3,
				content: [
					"",
					'it("requires permission", async () => {',
					"\tconst res = await api.get(path, { headers: await asUser({ permissions: [] }) });",
					"\texpect(res.status).toBe(403);",
					"});",
				].join("\n"),
			},
		);
	} else {
		fills.push({ slot: "test-auth", order: 2, content: "Object.assign(headers, await asUser());" });
	}
	return fills;
}

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else out.push(full);
	}
	return out;
}

function selectedSet(project: Project): Set<string> {
	const c = project.config;
	const set = new Set<string>([
		c.orm,
		c.database,
		c.auth,
		...c.addons,
		...c.authMethods.map((m) => `auth-${m}`),
	]);
	if (c.database !== "none") set.add("db");
	if (c.auth !== "none") set.add("auth");
	return set;
}

export async function generate(
	project: Project,
	request: GenerateRequest,
): Promise<GenerateResult> {
	const requirement = REQUIRES[request.kind];
	if (requirement && !project.has(requirement.feature)) {
		throw new GeneratorError(`Cannot make a ${request.kind}: ${requirement.hint}.`);
	}
	let n: Names;
	let m: Names;
	try {
		n = names(request.name);
		m = names(request.kind === "module" ? request.name : (request.module ?? ""));
	} catch (error) {
		if (request.kind !== "module" && !request.module) {
			throw new GeneratorError(
				`Pass --module <module> (the module the ${request.kind} belongs to).`,
			);
		}
		throw new GeneratorError((error as Error).message);
	}

	const root = join(TEMPLATES_DIR, "generators", request.kind);
	const selected = selectedSet(project);
	const dirs = (await readdir(root, { withFileTypes: true }))
		.filter((e) => e.isDirectory() && (e.name === "files" || e.name.startsWith("files+")))
		.map((e) => e.name)
		.filter(
			(d) =>
				d === "files" ||
				d
					.split("+")
					.slice(1)
					.every((id) => selected.has(id)),
		)
		.sort();

	const fills = [...guardSlots(project, n), ...testSlots(project, n)];
	const pm = pmCommands(project.config.packageManager);
	const rendered = new Map<string, string>();
	for (const dir of dirs) {
		const base = join(root, dir);
		for (const file of await walk(base)) {
			const rel = applyNames(applyNames(relative(base, file), "name", n), "module", m);
			let text = applyNames(applyNames(await readFile(file, "utf8"), "name", n), "module", m);
			text = text.replaceAll("__APP_NAME__", project.config.name).replaceAll("__PM_RUN__", pm.run);
			rendered.set(rel, fillSlots(text, fills));
		}
	}

	const existing = [...rendered.keys()].filter((rel) => existsSync(join(project.root, rel)));
	if (existing.length > 0) {
		throw new GeneratorError(`Refusing to overwrite existing file(s):\n  ${existing.join("\n  ")}`);
	}
	const routeSources = new Map<string, string>();
	for (const rel of await glob("src/**/routes/*.routes.ts", { cwd: project.root })) {
		routeSources.set(rel, await readFile(join(project.root, rel), "utf8"));
	}
	const before = routeMountCollisions(routeSources).length;
	for (const [rel, text] of rendered) routeSources.set(rel, text);
	const after = routeMountCollisions(routeSources);
	const collision = after.length > before ? after.at(-1) : undefined;
	if (collision) {
		throw new GeneratorError(
			`${collision.file}: ${collision.message}. Pick another --name, or create it and change basePath.`,
		);
	}
	const files = [...rendered.keys()].sort();
	if (request.dryRun) return { kind: request.kind, files, dryRun: true };

	for (const [rel, text] of rendered) {
		const full = join(project.root, rel);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, pointAtEjected(text, ejectedPackages(project.config)));
	}
	if (!request.skipPostProcess) await postProcess(project, files);
	return { kind: request.kind, files, dryRun: false };
}

/** Regenerates discovery output and formats the new files. */
export async function postProcess(project: Project, files: string[]): Promise<void> {
	const { sync } = await import("../commands/sync.ts");
	await sync(project);
	const biome = join(project.root, "node_modules/.bin/biome");
	const ts = files.filter((f) => f.endsWith(".ts"));
	if (existsSync(biome) && ts.length > 0) {
		await x(biome, ["check", "--write", ...ts], {
			nodeOptions: { cwd: project.root },
			throwOnError: false,
		});
	}
}
