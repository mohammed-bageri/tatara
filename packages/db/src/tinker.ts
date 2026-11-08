/** An interactive REPL with the app in scope (rails console / artisan tinker). */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import repl, { type REPLServer } from "node:repl";
import { pathToFileURL } from "node:url";
import { type CommandDefinition, defineCommand } from "@tatara/core";

export interface ServiceFile {
	/** the folder under a root, e.g. "billing" */
	module: string;
	/** camelCase file name without the suffix: "invoice-lines.service.ts" → "invoiceLines" */
	name: string;
	path: string;
}

export interface DiscoverServicesOptions {
	cwd?: string;
	/** folders holding `<module>/services/*<suffix>` (default ["src/modules"]) */
	roots?: readonly string[];
	/** default ".service.ts" */
	suffix?: string;
}

function directories(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

/** Every `<root>/<module>/services/*.service.ts`, without importing them. */
export function discoverServiceFiles(options: DiscoverServicesOptions = {}): ServiceFile[] {
	const { cwd = process.cwd(), roots = ["src/modules"], suffix = ".service.ts" } = options;
	const files: ServiceFile[] = [];
	for (const root of roots) {
		for (const module of directories(join(cwd, root))) {
			const dir = join(cwd, root, module, "services");
			let names: string[];
			try {
				names = readdirSync(dir)
					.filter((f) => f.endsWith(suffix))
					.sort();
			} catch {
				continue;
			}
			for (const file of names) {
				const base = file.slice(0, -suffix.length);
				const name = base.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
				files.push({ module, name, path: join(dir, file) });
			}
		}
	}
	return files;
}

/**
 * Imports every discovered service, grouped as `services.<module>.<name>`. A file that fails to
 * import is passed to `onError` and skipped, so the REPL still starts.
 */
export async function loadServices(
	options: DiscoverServicesOptions & { onError?: (error: unknown, file: ServiceFile) => void } = {},
): Promise<Record<string, Record<string, unknown>>> {
	const grouped: Record<string, Record<string, unknown>> = {};
	for (const file of discoverServiceFiles(options)) {
		try {
			const exports: unknown = await import(pathToFileURL(file.path).href);
			const group = grouped[file.module] ?? {};
			group[file.name] = exports;
			grouped[file.module] = group;
		} catch (error) {
			options.onError?.(error, file);
		}
	}
	return grouped;
}

/** The drizzle-orm operators worth having at the REPL's top level. */
export const DRIZZLE_OPERATORS = [
	"eq",
	"ne",
	"and",
	"or",
	"not",
	"inArray",
	"notInArray",
	"isNull",
	"isNotNull",
	"gt",
	"gte",
	"lt",
	"lte",
	"like",
	"ilike",
	"between",
	"desc",
	"asc",
	"count",
	"sum",
	"avg",
	"min",
	"max",
	"sql",
] as const;

/** `DRIZZLE_OPERATORS` picked from `import * as orm from "drizzle-orm"`. */
export function drizzleOperators(orm: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(DRIZZLE_OPERATORS.filter((n) => n in orm).map((n) => [n, orm[n]]));
}

export interface TinkerOptions {
	/** what is in scope, e.g. `{ db, ...schema, ...drizzleOperators(orm), services: await loadServices() }` */
	context(): Record<string, unknown> | Promise<Record<string, unknown>>;
	/** default "> " */
	prompt?: string;
	/** printed before the prompt */
	banner?(context: Record<string, unknown>): string;
	/** after the REPL closes, e.g. close the pool */
	onExit?(): void | Promise<void>;
	/** default process.stdin / process.stdout */
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
}

/** Starts the REPL with the context in scope; resolves once it closes (Ctrl-D, `.exit`). Top-level await works. */
export async function startTinker(options: TinkerOptions): Promise<void> {
	const context = await options.context();
	const output = options.output ?? process.stdout;
	if (options.banner) output.write(`${options.banner(context)}\n`);
	const server: REPLServer = repl.start({
		prompt: options.prompt ?? "> ",
		useGlobal: false,
		input: options.input ?? process.stdin,
		output,
		terminal: options.output ? false : undefined,
	});
	Object.assign(server.context, context);
	await new Promise<void>((resolve) => server.on("exit", resolve));
	await options.onExit?.();
}

/** `tinker` (or `name`) as an app command. */
export function tinkerCommand(
	options: TinkerOptions & { name?: string; description?: string },
): CommandDefinition {
	return defineCommand({
		name: options.name ?? "tinker",
		description:
			options.description ?? "Interactive REPL with the app's database and services in scope",
		run: () => startTinker(options),
	}) as CommandDefinition;
}
