/** Redis's default database count; worker N uses db `databases - N`, so db 0 is never one. */
const REDIS_DATABASES = 16;

export interface WorkerRedisOptions {
	/** The server's `databases` setting. Default 16. */
	databases?: number;
}

/** Worker N's Redis db: `16 - N`, for workers 1..15. */
export function workerRedisDb(worker: number | string, options: WorkerRedisOptions = {}): number {
	const databases = options.databases ?? REDIS_DATABASES;
	const n = typeof worker === "number" ? worker : Number(worker);
	if (!Number.isInteger(n) || n < 1 || n >= databases) {
		throw new Error(`Test worker must be 1..${databases - 1} (one Redis db each), got "${worker}"`);
	}
	return databases - n;
}

/** `baseUrl` pointed at worker N's db (any db in `baseUrl` is replaced). */
export function workerRedisUrl(
	baseUrl: string,
	worker: number | string,
	options?: WorkerRedisOptions,
): string {
	const url = new URL(baseUrl);
	url.pathname = `/${workerRedisDb(worker, options)}`;
	return url.toString();
}

/** The db index in a Redis URL; no path means db 0. */
export function redisDbOf(url: string): number {
	const path = new URL(url).pathname.replace(/^\//, "");
	return path === "" ? 0 : Number(path);
}

/** Throws unless `url` names a non-zero db: tests must never write to or flush db 0. */
export function assertTestRedisUrl(url: string): void {
	const db = redisDbOf(url);
	if (!Number.isInteger(db) || db <= 0) {
		throw new Error(`Tests must use a non-zero Redis db, got ${url}`);
	}
}

/** FLUSHDB on the db in `url`; refuses db 0. Needs `ioredis`. */
export async function flushRedisDb(url: string): Promise<void> {
	assertTestRedisUrl(url);
	const { Redis } = await import("ioredis");
	const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
	try {
		await redis.connect();
		await redis.flushdb();
	} finally {
		redis.disconnect();
	}
}

/** Flushes the db of each worker 1..`workers`; call once per run from global setup. */
export async function flushWorkerRedis(
	baseUrl: string,
	workers: number,
	options?: WorkerRedisOptions,
): Promise<void> {
	await Promise.all(
		Array.from({ length: workers }, (_, i) =>
			flushRedisDb(workerRedisUrl(baseUrl, i + 1, options)),
		),
	);
}
