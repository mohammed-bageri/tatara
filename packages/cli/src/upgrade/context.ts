import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { glob } from "tinyglobby";
import { renderApp } from "../engine/generate.ts";
import type { Project } from "../project/config.ts";
import { ejectedPackages, pointAtEjected } from "../project/ejected.ts";
import { hashContent } from "../project/hashes.ts";
import type { Baseline } from "./baseline.ts";
import { importsOf } from "./codemods/imports.ts";
import { currentPath } from "./moves.ts";

export interface UpgradeReport {
	ran: string[];
	/** files a codemod wrote (relative paths) */
	written: string[];
	/** written files that were what tatara generated before the write; only these join the record */
	regenerated: string[];
	removed: string[];
	kept: { path: string; diff: string }[];
	notes: string[];
	/** codemods that changed nothing because the app needs a hand edit first; they run again next time */
	blocked: string[];
}

export interface UpgradeContext {
	project: Project;
	baseline: Baseline;
	report: UpgradeReport;
	read(path: string): Promise<string>;
	write(path: string, text: string): Promise<void>;
	/** Deletes a framework file the app never changed; a changed file is kept and reported. */
	removeIfUnchanged(path: string): Promise<"removed" | "kept" | "missing">;
	/** Deletes a file whose content was written elsewhere (a move). */
	remove(path: string): Promise<void>;
	/** Rewrites `from` and `from/...` import specifiers in src/ and tests/; returns files changed. */
	rewriteImports(from: string, to: string): Promise<number>;
	addDependency(name: string, range: string, opts?: { dev?: boolean }): Promise<void>;
	/** What this CLI version generates at `path` for the app's options (undefined if nothing). */
	renderCurrent(path: string): Promise<string | undefined>;
	/** Writes what this CLI generates at `path`; when it generates nothing there, removes the file if unchanged. */
	regenerate(path: string): Promise<"written" | "removed" | "kept" | "missing">;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createContext(
	project: Project,
	appBaseline: Baseline,
	opts: { dryRun?: boolean } = {},
): UpgradeContext {
	// what an earlier codemod of this upgrade wrote is the CLI's, not the app's
	const ours = new Map<string, string>();
	const baseline: Baseline = {
		async isUnchanged(path, content) {
			return ours.get(path) === hashContent(content) || appBaseline.isUnchanged(path, content);
		},
	};
	const report: UpgradeReport = {
		ran: [],
		written: [],
		regenerated: [],
		removed: [],
		kept: [],
		notes: [],
		blocked: [],
	};
	const abs = (path: string) => join(project.root, path);
	let rendered: Promise<Map<string, string>> | undefined;
	const ejected = ejectedPackages(project.config);
	const write = async (path: string, written: string) => {
		// the app owns ejected packages: new code imports its copy, never the package
		const text = path.endsWith(".ts") ? pointAtEjected(written, ejected) : written;
		if (!report.written.includes(path)) {
			report.written.push(path);
			const before = existsSync(abs(path)) ? await readFile(abs(path), "utf8") : undefined;
			if (before === undefined || (await baseline.isUnchanged(path, before)))
				report.regenerated.push(path);
		}
		ours.set(path, hashContent(text));
		if (opts.dryRun) return;
		await mkdir(dirname(abs(path)), { recursive: true });
		await writeFile(abs(path), text);
	};

	const ctx: UpgradeContext = {
		project,
		baseline,
		report,
		read: (path) => readFile(abs(path), "utf8"),
		write,
		async remove(path) {
			if (!existsSync(abs(path))) return;
			if (!opts.dryRun) await rm(abs(path));
			report.removed.push(path);
		},
		async removeIfUnchanged(path) {
			if (!existsSync(abs(path))) return "missing";
			const content = await readFile(abs(path), "utf8");
			if (await baseline.isUnchanged(path, content)) {
				if (!opts.dryRun) await rm(abs(path));
				report.removed.push(path);
				return "removed";
			}
			// only hashes are recorded, so the diff shows the app's version of the file
			const diff = content
				.split("\n")
				.map((line) => `+${line}`)
				.join("\n");
			report.kept.push({ path, diff });
			return "kept";
		},
		async rewriteImports(from, to) {
			const pattern = new RegExp(`(["'])${escapeRegExp(from)}(?=(?:/[^"']*)?\\1)`, "g");
			let changed = 0;
			for (const path of await glob(["src/**/*.ts", "tests/**/*.ts"], {
				cwd: project.root,
				ignore: ["src/generated/**"],
			})) {
				const text = await readFile(abs(path), "utf8");
				const next = text.replace(pattern, `$1${to}`);
				if (next !== text) {
					await write(path, next);
					changed++;
				}
			}
			return changed;
		},
		async renderCurrent(path) {
			const { name, orm, database, auth, authMethods, addons, packageManager } = project.config;
			rendered ??= renderApp({ name, orm, database, auth, authMethods, addons, packageManager });
			return (await rendered).get(currentPath(path));
		},
		async regenerate(path) {
			const next = await ctx.renderCurrent(path);
			if (next === undefined) {
				// no longer generated, but still imported: removing it would break the importer
				const spec = `#${path.replace(/^src\//, "").replace(/\.ts$/, "")}`;
				const importers: string[] = [];
				for (const other of await glob(["src/**/*.ts", "tests/**/*.ts"], {
					cwd: project.root,
					ignore: ["src/generated/**"],
				})) {
					if (other !== path && importsOf(await readFile(abs(other), "utf8"), spec))
						importers.push(other);
				}
				if (importers.length > 0) {
					report.notes.push(`${path} was kept: ${importers.join(", ")} import it.`);
					return "kept";
				}
				return ctx.removeIfUnchanged(path);
			}
			await write(path, next);
			return "written";
		},
		async addDependency(name, range, { dev = false } = {}) {
			if (ejected.includes(name.replace(/^@tatara\//, ""))) {
				const note = `${name} is ejected; it was not added (its code is in src/ejected)`;
				if (!report.notes.includes(note)) report.notes.push(note);
				return;
			}
			const pkg = JSON.parse(await readFile(abs("package.json"), "utf8")) as Record<
				string,
				Record<string, string> | undefined
			>;
			const key = dev ? "devDependencies" : "dependencies";
			pkg[key] = { ...pkg[key], [name]: range };
			await write("package.json", `${JSON.stringify(pkg, null, "\t")}\n`);
		},
	};
	return ctx;
}
