import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "tinyglobby";
import { loadProject, type Project } from "../project/config.ts";
import { nonLiteralMounts, routeMountCollisions } from "./route-mounts.ts";

export interface Violation {
	file: string;
	line: number;
	rule: string;
	message: string;
}

const IMPORT =
	/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g;

/** Specifiers vitest resolves like imports; only checked for `../`. */
const VI_IMPORT =
	/\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<[^>]*>)?\(\s*["']([^"']+)["']/g;

const PUBLIC_FOLDERS = new Set(["services", "db", "events"]);

/** Module folders tatara discovers (`tatara sync`) or the layout names, whatever the add-ons. */
const MODULE_FOLDERS = [
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
	"workflows",
	"activities",
	"workflow-schedules",
];

const TEST_FILE = /\.test\.ts$/;

function lineOf(text: string, index: number): number {
	return text.slice(0, index).split("\n").length;
}

/** Layout rules from AGENTS.md. Returns every violation; empty means the layout is clean. */
export async function check(project: Project = loadProject()): Promise<Violation[]> {
	const { root } = project;
	const files = await glob(["src/**/*.ts", "tests/**/*.ts"], {
		cwd: root,
		ignore: ["src/generated/**"],
	});
	const violations: Violation[] = [];
	const sources = new Map<string, string>();
	for (const file of files.sort()) {
		const text = await readFile(join(root, file), "utf8");
		sources.set(file, text);
		const moduleName = /^src\/modules\/([^/]+)\//.exec(file)?.[1];

		for (const match of text.matchAll(VI_IMPORT)) {
			const spec = match[1] ?? "";
			if (spec.startsWith("../")) {
				violations.push({
					file,
					line: lineOf(text, match.index),
					rule: "no-parent-imports",
					message: `use a # specifier instead of "${spec}"`,
				});
			}
		}

		for (const match of text.matchAll(IMPORT)) {
			const spec = match[1] ?? match[2] ?? match[3] ?? "";
			const line = lineOf(text, match.index);
			if (spec.startsWith("../")) {
				violations.push({
					file,
					line,
					rule: "no-parent-imports",
					message: `use a # import instead of "${spec}"`,
				});
			}
			if (file.startsWith("src/core/") && spec.startsWith("#modules/")) {
				violations.push({
					file,
					line,
					rule: "core-imports-modules",
					message: `core must not import modules ("${spec}")`,
				});
			}
			const target = /^#modules\/([^/]+)\/([^/]+)/.exec(spec);
			// a module's public surface: its services, its tables (joins and foreign keys) and the
			// domain events it publishes (other modules subscribe to them)
			if (
				moduleName &&
				target &&
				target[1] !== moduleName &&
				!PUBLIC_FOLDERS.has(target[2] ?? "")
			) {
				violations.push({
					file,
					line,
					rule: "cross-module-imports",
					message: `use ${target[1]}'s services, tables or events, not "${spec}"`,
				});
			}
		}

		if (TEST_FILE.test(file) && !file.startsWith("tests/") && !file.includes("/tests/")) {
			violations.push({
				file,
				line: 1,
				rule: "tests-location",
				message: "move the test into a tests/ folder (src/modules/<module>/tests/ or tests/)",
			});
		}

		if (/\/routes\/[^/]+\.routes\.ts$/.test(file)) {
			const wildcard = /\.use\(\s*["']\*["']/.exec(text);
			if (wildcard) {
				violations.push({
					file,
					line: lineOf(text, wildcard.index),
					rule: "no-wildcard-middleware",
					message: 'module routers must not call use("*"); attach middleware per route or path',
				});
			}
		}

		if (
			file.startsWith("src/") &&
			file !== "src/core/config/env.ts" &&
			!file.includes("/tests/") &&
			/\bprocess\.env\b/.test(text)
		) {
			const index = text.search(/\bprocess\.env\b/);
			violations.push({
				file,
				line: lineOf(text, index),
				rule: "env-access",
				message: "read configuration from #core/config/env, not process.env",
			});
		}
	}
	violations.push(...nonLiteralMounts(sources));
	violations.push(...routeMountCollisions(sources));
	violations.push(...(await moduleFolderViolations(project)));
	return violations.filter((v) => !ignored(v, sources.get(v.file) ?? ""));
}

/**
 * A module's top-level folders must be ones tatara knows, or the folder of a tatara.json
 * `registries` glob (`src/modules/*\/<folder>/…` for every module, `src/modules/<m>/<folder>/…` for one;
 * `src/{modules,core}/…` counts as modules).
 */
async function moduleFolderViolations(project: Project): Promise<Violation[]> {
	const everywhere = new Set(MODULE_FOLDERS);
	const perModule = new Map<string, Set<string>>();
	for (const kind of project.config.registries ?? []) {
		for (const pattern of [kind.glob].flat()) {
			const match = /^(?:\.\/)?src\/([^/]+)\/([^/]+)\/([^/]+)\//.exec(pattern);
			if (!match?.[1] || !match[2] || !match[3]) continue;
			const [, scope, owner, folder] = match;
			if (scope !== "modules" && !expand(scope).includes("modules")) continue;
			const folders = /[*?{}[\]!]/.test(folder) ? expand(folder) : [folder];
			if (/[*?{}[\]!]/.test(owner)) for (const f of folders) everywhere.add(f);
			else {
				const own = perModule.get(owner) ?? new Set<string>();
				for (const f of folders) own.add(f);
				perModule.set(owner, own);
			}
		}
	}
	const dirs = await glob(["src/modules/*/*/"], { cwd: project.root, onlyDirectories: true });
	const violations: Violation[] = [];
	for (const dir of dirs.sort()) {
		const [, , moduleName = "", folder = ""] = dir.split("/");
		if (everywhere.has(folder) || perModule.get(moduleName)?.has(folder)) continue;
		violations.push({
			file: dir.endsWith("/") ? dir : `${dir}/`,
			line: 1,
			rule: "module-folders",
			message: `"${folder}" is not a module folder tatara knows (AGENTS.md); move the code into one, or declare a tatara.json registry for it`,
		});
	}
	return violations;
}

/** `{a,b}` → [a, b]; any other glob folder can't be named, so it allows nothing. */
function expand(folder: string): string[] {
	const braces = /^\{([^{}*?]+)\}$/.exec(folder);
	return braces?.[1] ? braces[1].split(",") : [];
}

/** `// tatara-check-ignore <rule>: <reason>` on the line above a violation silences it. */
function ignored(v: Violation, text: string): boolean {
	const previous = text.split("\n")[v.line - 2] ?? "";
	return new RegExp(`tatara-check-ignore\\s+${v.rule}:\\s*\\S`).test(previous);
}
