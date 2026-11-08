import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Dictionary } from "./index.ts";

export interface LoadDictionariesOptions {
	/** holds `<language>/<namespace>.json`, e.g. `${process.cwd()}/locales` */
	dir: string;
	/** default: every sub-directory of `dir` */
	languages?: readonly string[];
	/** default: every `*.json` file found in any language */
	namespaces?: readonly string[];
	/** a namespace file one language lacks; that namespace is `{}` there */
	onMissing?: (language: string, namespace: string) => void;
}

async function list(dir: string, pick: (name: string, isDir: boolean) => string | undefined) {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries.flatMap((e) => pick(e.name, e.isDirectory()) ?? []).sort();
}

/**
 * Reads `<dir>/<language>/<namespace>.json` into `{ [language]: { [namespace]: … } }`, so
 * `t(language, "namespace:key")` finds them. Namespaces are discovered from the files.
 */
export async function loadDictionaries(
	options: LoadDictionariesOptions,
): Promise<Record<string, Dictionary>> {
	const languages =
		options.languages ?? (await list(options.dir, (name, isDir) => (isDir ? name : undefined)));
	const files = new Map<string, string[]>();
	for (const language of languages) {
		const names = await list(join(options.dir, language), (name, isDir) =>
			!isDir && name.endsWith(".json") ? name.slice(0, -".json".length) : undefined,
		).catch(() => []);
		files.set(language, names);
	}
	const namespaces = options.namespaces ?? [...new Set([...files.values()].flat())].sort();
	const result: Record<string, Dictionary> = {};
	for (const language of languages) {
		const dictionary: Dictionary = {};
		for (const namespace of namespaces) {
			if (!files.get(language)?.includes(namespace)) {
				options.onMissing?.(language, namespace);
				dictionary[namespace] = {};
				continue;
			}
			const text = await readFile(join(options.dir, language, `${namespace}.json`), "utf8");
			dictionary[namespace] = JSON.parse(text) as Dictionary;
		}
		result[language] = dictionary;
	}
	return result;
}
