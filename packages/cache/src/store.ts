/**
 * What a driver implements: raw string values, each operation atomic on its own. `createCache`
 * builds the rest (JSON values, prefixes, wrap, lock) on top, the same for every driver.
 */
export interface CacheStore {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttlMs?: number): Promise<void>;
	/** sets only when the key is absent (or expired); true when this call set it */
	add(key: string, value: string, ttlMs?: number): Promise<boolean>;
	/** reads and deletes in one step */
	take(key: string): Promise<string | null>;
	del(keys: string[]): Promise<void>;
	/** deletes the key only while it still holds `value` */
	delIfEquals(key: string, value: string): Promise<boolean>;
	/** resets the key's expiry to `ttlMs` only while it still holds `value` (a lock renewing itself) */
	extendIfEquals(key: string, value: string, ttlMs: number): Promise<boolean>;
	/** every key starting with `prefix`; returns how many went */
	delPrefix(prefix: string): Promise<number>;
	/** adds `by` (a missing key counts as 0); `ttlMs` applies only when the key has no expiry yet */
	increment(key: string, by: number, ttlMs?: number): Promise<number>;
}
