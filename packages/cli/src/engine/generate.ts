import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { stringify } from "yaml";
import type { AppOptions, EnvVar, Feature } from "../features/types.ts";
import { cliVersion, TEMPLATES_DIR, versionOf } from "../paths.ts";
import { pmCommands } from "../pm.ts";
import type { ProjectConfig } from "../project/config.ts";
import { isApplicable, resolveFeatures } from "./resolve.ts";
import { fillSlots, type SlotFill } from "./slots.ts";

const RENAMES: Record<string, string> = {
	_github: ".github",
	gitignore: ".gitignore",
	dockerignore: ".dockerignore",
	"biome.template.json": "biome.json",
};

export type FileMap = Map<string, string>;

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else out.push(full);
	}
	return out;
}

function mapPath(rel: string): string {
	return rel
		.split(sep)
		.map((segment) => RENAMES[segment] ?? segment)
		.join("/");
}

/** `files` plus every `files+a+b` folder whose features are all selected. */
async function featureFileDirs(feature: Feature, selected: ReadonlySet<string>): Promise<string[]> {
	const root = join(TEMPLATES_DIR, "features", feature.templateDir ?? feature.id);
	if (!existsSync(root)) return [];
	const dirs = (await readdir(root, { withFileTypes: true }))
		.filter((e) => e.isDirectory() && (e.name === "files" || e.name.startsWith("files+")))
		.map((e) => e.name)
		.filter(
			(name) =>
				name === "files" ||
				name
					.split("+")
					.slice(1)
					.every((id) => selected.has(id)),
		)
		.sort((a, b) => a.split("+").length - b.split("+").length || a.localeCompare(b));
	return dirs.map((d) => join(root, d));
}

export async function collectTemplateFiles(
	features: Feature[],
	selected: ReadonlySet<string>,
): Promise<FileMap> {
	const files: FileMap = new Map();
	for (const feature of features) {
		for (const dir of await featureFileDirs(feature, selected)) {
			for (const file of await walk(dir)) {
				files.set(mapPath(relative(dir, file)), await readFile(file, "utf8"));
			}
		}
	}
	return files;
}

export function applySlots(files: FileMap, features: Feature[], selected: ReadonlySet<string>) {
	const byFile = new Map<string, SlotFill[]>();
	let order = 0;
	for (const feature of features) {
		for (const slot of feature.slots ?? []) {
			if (!isApplicable(slot, selected)) continue;
			// a contribution may target a file that only exists for some combinations
			if (!files.has(slot.file)) continue;
			const list = byFile.get(slot.file) ?? [];
			list.push({ slot: slot.slot, content: slot.content, order: slot.order ?? 100 + order++ });
			byFile.set(slot.file, list);
		}
	}
	for (const [path, text] of files) {
		files.set(path, fillSlots(text, byFile.get(path) ?? []));
	}
}

export function tokens(options: AppOptions): Record<string, string> {
	const pm = pmCommands(options.packageManager);
	return {
		__APP_NAME__: options.name,
		__APP_DB__: options.name.replaceAll("-", "_"),
		__PM_RUN__: pm.run,
		__PM_EXEC__: options.packageManager === "pnpm" ? "pnpm" : pm.exec,
		__BIOME_VERSION__: versionOf("@biomejs/biome"),
	};
}

export function applyTokens(text: string, values: Record<string, string>): string {
	let out = text;
	for (const [token, value] of Object.entries(values)) out = out.replaceAll(token, value);
	return out;
}

function envValue(v: EnvVar, kind: "example" | "dev" | "test"): string {
	if (kind === "example") return v.example;
	if (v.secret && kind === "dev") return randomBytes(32).toString("base64url");
	if (kind === "test")
		return v.test ?? (v.secret ? "test-secret-test-secret-test-secret-00" : (v.dev ?? v.example));
	return v.dev ?? v.example;
}

export function envFile(vars: EnvVar[], kind: "example" | "dev" | "test"): string {
	const lines: string[] = [];
	for (const v of vars) {
		if (v.comment) lines.push(`# ${v.comment}`);
		lines.push(`${v.key}=${envValue(v, kind)}`);
	}
	return `${lines.join("\n")}\n`;
}

export function envModule(vars: EnvVar[]): string {
	const fields = vars.map((v) => `\t\t${v.key}: ${v.schema},`).join("\n");
	return `import { createEnv } from "@t3-oss/env-core";
import { createLocalDefault } from "@tatara/core";
import { z } from "zod";

/** A default for local development; production must set the value explicitly. */
const localDefault = createLocalDefault(process.env.NODE_ENV === "production");

/** The only place that reads process.env. Add new variables here and to .env.example. */
export const env = createEnv({
	server: {
${fields}
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});
`;
}

function dedupeEnv(features: Feature[], tokenValues: Record<string, string>): EnvVar[] {
	const seen = new Map<string, EnvVar>();
	for (const f of features) {
		for (const v of f.env ?? []) {
			const resolved: EnvVar = {
				...v,
				example: applyTokens(v.example, tokenValues),
				...(v.dev === undefined ? {} : { dev: applyTokens(v.dev, tokenValues) }),
				...(v.test === undefined ? {} : { test: applyTokens(v.test, tokenValues) }),
			};
			seen.set(v.key, resolved);
		}
	}
	return [...seen.values()];
}

function sortObject(input: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}

export function packageJson(options: AppOptions, features: Feature[], pmVersion?: string): string {
	const dependencies: Record<string, string> = {};
	const devDependencies: Record<string, string> = {};
	let scripts: Record<string, string> = {};
	for (const f of features) {
		for (const d of f.dependencies ?? []) dependencies[d] = versionOf(d);
		for (const d of f.devDependencies ?? []) devDependencies[d] = versionOf(d);
		scripts = { ...scripts, ...f.scripts };
	}
	for (const d of Object.keys(dependencies)) delete devDependencies[d];
	const pkg: Record<string, unknown> = {
		name: options.name,
		version: "0.1.0",
		private: true,
		type: "module",
		engines: { node: ">=24" },
		...(options.packageManager === "pnpm" && pmVersion
			? { packageManager: `pnpm@${pmVersion}` }
			: {}),
		imports: {
			"#apps/*": "./src/apps/*.ts",
			"#core/*": "./src/core/*.ts",
			"#modules/*": "./src/modules/*.ts",
			"#generated/*": "./src/generated/*.ts",
			"#tests/*": "./tests/*.ts",
			"#locales/*": "./src/locales/*.json",
		},
		scripts,
		dependencies: sortObject(dependencies),
		devDependencies: sortObject(devDependencies),
	};
	return `${JSON.stringify(pkg, null, "\t")}\n`;
}

export function composeFile(
	options: AppOptions,
	features: Feature[],
	tokenValues: Record<string, string>,
) {
	const services: Record<string, unknown> = {};
	const volumes: Record<string, null> = {};
	for (const f of features) {
		Object.assign(services, f.compose ?? {});
		for (const v of f.composeVolumes ?? []) volumes[v] = null;
	}
	if (Object.keys(services).length === 0) return undefined;
	const doc = {
		name: `\${COMPOSE_PROJECT_NAME:-${options.name}}`,
		services,
		...(Object.keys(volumes).length > 0 ? { volumes } : {}),
	};
	return applyTokens(stringify(doc, { lineWidth: 0 }).replaceAll(": null", ":"), tokenValues);
}

export function pnpmWorkspace(features: Feature[]): string {
	const builds = [...new Set(features.flatMap((f) => f.allowBuilds ?? []))].sort();
	const lines = ["# Packages allowed to run install scripts."];
	if (builds.length === 0) lines.push("allowBuilds: {}");
	else lines.push("allowBuilds:", ...builds.map((b) => `  "${b}": true`));
	lines.push(
		"# tatara's own packages are installed as soon as they are released",
		"minimumReleaseAgeExclude:",
		'  - "@tatara/*"',
	);
	return `${lines.join("\n")}\n`;
}

export interface GenerateOptions {
	pmVersion?: string;
	/** include tatara's own tests of its wiring (the tests folders under src/core); e2e runs them */
	frameworkTests?: boolean;
}

/** Tests of tatara's wiring, not of the app; generated apps leave them out. */
export function isFrameworkTest(path: string): boolean {
	// tests/tatara/ since 0.10; src/core/<area>/tests/ before, so older apps' copies are still recognised
	return path.startsWith("tests/tatara/") || /^src\/core\/.+\/tests\/[^/]+\.test\.ts$/.test(path);
}

/** Folds applicable variants into each feature so later steps see one flat definition. */
export function effectiveFeatures(options: AppOptions): Feature[] {
	const features = resolveFeatures(options);
	const selected = new Set(features.map((f) => f.id));
	return features.map((f) => {
		const variants = (f.variants ?? []).filter((v) => isApplicable(v, selected));
		if (variants.length === 0) return f;
		return {
			...f,
			dependencies: [...(f.dependencies ?? []), ...variants.flatMap((v) => v.dependencies ?? [])],
			devDependencies: [
				...(f.devDependencies ?? []),
				...variants.flatMap((v) => v.devDependencies ?? []),
			],
			scripts: Object.assign({}, f.scripts, ...variants.map((v) => v.scripts ?? {})),
			allowBuilds: [...(f.allowBuilds ?? []), ...variants.flatMap((v) => v.allowBuilds ?? [])],
			env: [...(f.env ?? []), ...variants.flatMap((v) => v.env ?? [])],
		};
	});
}

/** Renders the whole app in memory: template files, slots, tokens and generated config. */
export async function renderApp(
	options: AppOptions,
	generate: GenerateOptions = {},
): Promise<FileMap> {
	const features = effectiveFeatures(options);
	const selected = new Set(features.map((f) => f.id));
	const tokenValues = tokens(options);
	const files = await collectTemplateFiles(features, selected);
	if (!generate.frameworkTests)
		for (const path of files.keys()) if (isFrameworkTest(path)) files.delete(path);

	const env = dedupeEnv(features, tokenValues);
	files.set("src/core/config/env.ts", envModule(env.filter((v) => !v.composeOnly)));
	files.set(".env.example", envFile(env, "example"));
	files.set(".env.test", envFile(env, "test"));

	const compose = composeFile(options, features, tokenValues);
	const slotFeatures: Feature[] = compose
		? [
				...features,
				{
					id: "_compose",
					kind: "base",
					label: "compose",
					slots: [
						{
							file: ".github/workflows/ci.yml",
							slot: "ci-services",
							content: "- run: docker compose up -d --wait",
						},
					],
				},
			]
		: features;
	applySlots(files, slotFeatures, selected);
	for (const [path, text] of files) files.set(path, applyTokens(text, tokenValues));

	files.set("package.json", packageJson(options, features, generate.pmVersion));
	if (compose) files.set("compose.yaml", compose);
	if (options.packageManager === "pnpm") files.set("pnpm-workspace.yaml", pnpmWorkspace(features));

	const config: ProjectConfig = {
		$schema: "https://raw.githubusercontent.com/mohammed-bageri/tatara/main/schema/tatara.json",
		version: cliVersion(),
		name: options.name,
		orm: options.orm,
		database: options.database,
		auth: options.auth,
		authMethods: options.authMethods,
		addons: options.addons,
		packageManager: options.packageManager,
	};
	files.set("tatara.json", `${JSON.stringify(config, null, "\t")}\n`);
	return files;
}

export async function writeFiles(targetDir: string, files: FileMap, extra: { env?: string } = {}) {
	for (const [path, content] of files) {
		const full = join(targetDir, path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, content);
	}
	if (extra.env !== undefined) await writeFile(join(targetDir, ".env"), extra.env);
}

export function devEnvFromExample(options: AppOptions): string {
	const features = effectiveFeatures(options);
	return envFile(dedupeEnv(features, tokens(options)), "dev");
}
