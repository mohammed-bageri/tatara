import { randomUUID } from "node:crypto";
import type { CacheStore } from "./store.ts";

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

export interface Cache {
	get<T>(key: string): Promise<T | null>;
	set<T>(key: string, value: T, options?: { ttlMs?: number }): Promise<void>;
	/** sets only when absent, e.g. a single-use ticket; true when this call set it */
	add<T>(key: string, value: T, options?: { ttlMs?: number }): Promise<boolean>;
	/** reads and deletes: a value that may be used once (tickets, OAuth state) */
	take<T>(key: string): Promise<T | null>;
	del(...keys: string[]): Promise<void>;
	/** every key under `prefix`, e.g. `orgKey(orgId)` to drop an org's entries */
	delPrefix(prefix: string): Promise<number>;
	/** a counter; `ttlMs` starts its window when it is created (fixed-window rate limits) */
	increment(key: string, options?: { by?: number; ttlMs?: number }): Promise<number>;
	/** the cached value, else `fn()` cached for `ttlMs`; a failing store falls back to `fn()` */
	wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
	/**
	 * runs `fn` only while holding the lock, released after; another holder means not acquired.
	 * With `renew`, the lock is extended every `ttlMs / 2` while `fn` runs, so work longer than
	 * `ttlMs` keeps it; a crashed holder's lock still expires after `ttlMs`.
	 */
	lock<T>(
		key: string,
		ttlMs: number,
		fn: () => Promise<T>,
		options?: { renew?: boolean },
	): Promise<LockResult<T>>;
}

export interface CacheOptions {
	/** namespaces every key, e.g. the app name, so apps can share one Redis */
	prefix?: string;
	/** called when `wrap` falls back because the store failed (log it) */
	onError?: (error: unknown, key: string) => void;
}

function assertKey(key: string): string {
	if (!key) throw new Error("Cache keys must not be empty");
	return key;
}

function assertTtl(ttlMs: number | undefined): number | undefined {
	if (ttlMs !== undefined && !(Number.isInteger(ttlMs) && ttlMs > 0))
		throw new Error(`Cache TTLs are positive whole milliseconds, got ${ttlMs}`);
	return ttlMs;
}

const parse = <T>(raw: string | null): T | null => (raw === null ? null : (JSON.parse(raw) as T));

/** The cache contract over any driver's store. */
export function createCache(store: CacheStore, options: CacheOptions = {}): Cache {
	const ns = options.prefix ? `${options.prefix}:` : "";
	const k = (key: string) => ns + assertKey(key);

	const cache: Cache = {
		async get(key) {
			return parse(await store.get(k(key)));
		},
		async set(key, value, opts) {
			await store.set(k(key), JSON.stringify(value), assertTtl(opts?.ttlMs));
		},
		async add(key, value, opts) {
			return store.add(k(key), JSON.stringify(value), assertTtl(opts?.ttlMs));
		},
		async take(key) {
			return parse(await store.take(k(key)));
		},
		async del(...keys) {
			if (keys.length > 0) await store.del(keys.map(k));
		},
		async delPrefix(prefix) {
			return store.delPrefix(k(prefix));
		},
		async increment(key, opts) {
			const by = opts?.by ?? 1;
			if (!Number.isSafeInteger(by))
				throw new Error(`Cache increments are whole numbers, got ${by}`);
			return store.increment(k(key), by, assertTtl(opts?.ttlMs));
		},
		async wrap(key, ttlMs, fn) {
			assertTtl(ttlMs);
			let cached: string | null = null;
			try {
				cached = await store.get(k(key));
			} catch (error) {
				options.onError?.(error, key);
				return fn();
			}
			if (cached !== null) return JSON.parse(cached);
			const value = await fn();
			try {
				await store.set(k(key), JSON.stringify(value), ttlMs);
			} catch (error) {
				options.onError?.(error, key);
			}
			return value;
		},
		async lock(key, ttlMs, fn, lockOptions) {
			const lockKey = k(`lock:${key}`);
			const token = randomUUID();
			if (!(await store.add(lockKey, token, assertTtl(ttlMs)))) return { acquired: false };
			const renewal = lockOptions?.renew
				? setInterval(
						() => {
							store.extendIfEquals(lockKey, token, ttlMs).then(
								(held) => {
									// lost (expired and taken): stop renewing someone else's lock
									if (!held) clearInterval(renewal);
								},
								(error: unknown) => options.onError?.(error, key),
							);
						},
						Math.max(1, Math.floor(ttlMs / 2)),
					)
				: undefined;
			renewal?.unref?.();
			try {
				return { acquired: true, value: await fn() };
			} finally {
				if (renewal) clearInterval(renewal);
				// only our own lock: if it expired and someone else took it, theirs stays
				await store.delIfEquals(lockKey, token);
			}
		},
	};
	return cache;
}

/** `org:<id>:<parts>`: an org's keys share a prefix, so `delPrefix(orgKey(id))` drops them all. */
export function orgKey(orgId: string, ...parts: string[]): string {
	return ["org", orgId, ...parts].map(encodeURIComponent).join(":") + (parts.length ? "" : ":");
}

/** `user:<id>:<parts>`, the same for a user's keys. */
export function userKey(userId: string, ...parts: string[]): string {
	return ["user", userId, ...parts].map(encodeURIComponent).join(":") + (parts.length ? "" : ":");
}
