import type { CacheStore } from "./store.ts";

interface Entry {
	value: string;
	expiresAt: number | null;
}

/** An in-process store for dev and tests. Each process has its own; use Redis or Postgres to share. */
export function memoryStore(): CacheStore {
	const entries = new Map<string, Entry>();
	let writes = 0;

	const live = (key: string): Entry | undefined => {
		const entry = entries.get(key);
		if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
			entries.delete(key);
			return undefined;
		}
		return entry;
	};
	const put = (key: string, value: string, ttlMs?: number) => {
		// expired entries nobody reads again would otherwise stay forever
		if (++writes % 1000 === 0) for (const k of [...entries.keys()]) live(k);
		entries.set(key, { value, expiresAt: ttlMs === undefined ? null : Date.now() + ttlMs });
	};

	return {
		async get(key) {
			return live(key)?.value ?? null;
		},
		async set(key, value, ttlMs) {
			put(key, value, ttlMs);
		},
		async add(key, value, ttlMs) {
			if (live(key)) return false;
			put(key, value, ttlMs);
			return true;
		},
		async take(key) {
			const entry = live(key);
			entries.delete(key);
			return entry?.value ?? null;
		},
		async del(keys) {
			for (const key of keys) entries.delete(key);
		},
		async delIfEquals(key, value) {
			if (live(key)?.value !== value) return false;
			entries.delete(key);
			return true;
		},
		async extendIfEquals(key, value, ttlMs) {
			const entry = live(key);
			if (entry?.value !== value) return false;
			entry.expiresAt = Date.now() + ttlMs;
			return true;
		},
		async delPrefix(prefix) {
			let count = 0;
			for (const key of [...entries.keys()])
				if (key.startsWith(prefix) && live(key)) {
					entries.delete(key);
					count++;
				}
			return count;
		},
		async increment(key, by, ttlMs) {
			const entry = live(key);
			const next = Number(entry?.value ?? 0) + by;
			if (entry) entry.value = String(next);
			else put(key, String(next), ttlMs);
			if (entry && entry.expiresAt === null && ttlMs !== undefined)
				entry.expiresAt = Date.now() + ttlMs;
			return next;
		},
	};
}
