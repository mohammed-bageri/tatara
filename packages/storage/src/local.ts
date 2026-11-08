import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertKey, type Storage, type StoredObject } from "./storage.ts";

/** Files on disk under `root`; for development and tests. URLs are `file://` paths. */
export function localStorage(root: string): Storage {
	const base = resolve(root);
	const path = (key: string) => {
		const full = resolve(base, assertKey(key));
		if (!full.startsWith(base + sep)) throw new Error(`Invalid storage key "${key}"`);
		return full;
	};
	return {
		async put(key, body) {
			await mkdir(dirname(path(key)), { recursive: true });
			await writeFile(path(key), body);
		},
		async get(key) {
			try {
				return new Uint8Array(await readFile(path(key)));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
		},
		async delete(key) {
			await rm(path(key), { force: true });
		},
		async url(key) {
			return `file://${path(key)}`;
		},
		async uploadUrl(key) {
			return `file://${path(key)}`;
		},
		async list(prefix = "") {
			const out: StoredObject[] = [];
			let entries: string[];
			try {
				entries = await readdir(base, { recursive: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
				throw error;
			}
			for (const entry of entries.sort()) {
				const full = join(base, entry);
				const info = await stat(full);
				if (!info.isFile()) continue;
				const key = relative(base, full).split(sep).join("/");
				if (key.startsWith(prefix)) out.push({ key, lastModified: info.mtime, size: info.size });
			}
			return out;
		},
		async copy(fromKey, toKey) {
			await mkdir(dirname(path(toKey)), { recursive: true });
			await copyFile(path(fromKey), path(toKey));
		},
	};
}
