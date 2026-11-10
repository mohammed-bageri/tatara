# @tatara/cache

Part of [tatara](https://github.com/mohammed-bageri/tatara).

One cache contract with three drivers: `memoryStore()` (dev and tests), `redisStore(redis)` from
`@tatara/cache/redis`, and `postgresStore(pool)` from `@tatara/cache/postgres` (an unlogged table in
its own `tatara` schema, so ORM migrations never see it).

```ts
import { createCache, orgKey } from "@tatara/cache";

const cache = createCache(memoryStore(), { prefix: "app" });
await cache.wrap(orgKey(orgId, "dashboard"), 60_000, () => loadDashboard(orgId));
await cache.lock("nightly-report", 60_000, () => buildReport());
```
