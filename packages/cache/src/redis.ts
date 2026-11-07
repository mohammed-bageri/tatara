import type { Redis } from "ioredis";
import type { CacheStore } from "./store.ts";

const INCREMENT = `local v = redis.call("incrby", KEYS[1], ARGV[1])
if tonumber(ARGV[2]) > 0 and redis.call("pttl", KEYS[1]) == -1 then redis.call("pexpire", KEYS[1], ARGV[2]) end
return v`;
const DEL_IF_EQUALS = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const EXTEND_IF_EQUALS = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

type RedisClient = Pick<Redis, "get" | "set" | "getdel" | "del" | "unlink" | "eval" | "scanStream">;

/** Redis glob characters in a prefix match literally. */
const escapeGlob = (text: string) => text.replace(/[*?[\]\\]/g, "\\$&");

/** A store in Redis (or Valkey, Dragonfly). Pass a client, or a function that opens one lazily. */
export function redisStore(redis: RedisClient | (() => RedisClient)): CacheStore {
	const client = typeof redis === "function" ? redis : () => redis;
	return {
		get: (key) => client().get(key),
		async set(key, value, ttlMs) {
			if (ttlMs === undefined) await client().set(key, value);
			else await client().set(key, value, "PX", ttlMs);
		},
		async add(key, value, ttlMs) {
			const ok =
				ttlMs === undefined
					? await client().set(key, value, "NX")
					: await client().set(key, value, "PX", ttlMs, "NX");
			return ok === "OK";
		},
		take: (key) => client().getdel(key),
		async del(keys) {
			await client().del(...keys);
		},
		async delIfEquals(key, value) {
			return (await client().eval(DEL_IF_EQUALS, 1, key, value)) === 1;
		},
		async extendIfEquals(key, value, ttlMs) {
			return (await client().eval(EXTEND_IF_EQUALS, 1, key, value, ttlMs)) === 1;
		},
		async delPrefix(prefix) {
			const stream = client().scanStream({ match: `${escapeGlob(prefix)}*`, count: 500 });
			let count = 0;
			for await (const keys of stream as AsyncIterable<string[]>) {
				if (keys.length === 0) continue;
				count += await client().unlink(...keys);
			}
			return count;
		},
		async increment(key, by, ttlMs) {
			return Number(await client().eval(INCREMENT, 1, key, by, ttlMs ?? 0));
		},
	};
}
