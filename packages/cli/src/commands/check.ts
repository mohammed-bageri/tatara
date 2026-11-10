import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "tinyglobby";
import { loadProject, type Project } from "../project/config.ts";
import { routeMountCollisions } from "./route-mounts.ts";

export interface Violation {
	file: string;
	line: number;
	rule: string;
	message: string;
}

const IMPORT =
	/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

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

		for (const match of text.matchAll(IMPORT)) {
			const spec = match[1] ?? match[2] ?? "";
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
			// a module's public surface: its services and its tables (joins and foreign keys)
			if (
				moduleName &&
				target &&
				target[1] !== moduleName &&
				target[2] !== "services" &&
				target[2] !== "db"
			) {
				violations.push({
					file,
					line,
					rule: "cross-module-imports",
					message: `use ${target[1]}'s services or tables, not "${spec}"`,
				});
			}
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
	violations.push(...routeMountCollisions(sources));
	return violations.filter((v) => !ignored(v, sources.get(v.file) ?? ""));
}

/** `// tatara-check-ignore <rule>: <reason>` on the line above a violation silences it. */
function ignored(v: Violation, text: string): boolean {
	const previous = text.split("\n")[v.line - 2] ?? "";
	return new RegExp(`tatara-check-ignore\\s+${v.rule}:\\s*\\S`).test(previous);
}
