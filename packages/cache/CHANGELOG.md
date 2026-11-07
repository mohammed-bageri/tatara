# @tatara/cache

## 0.2.0

### Minor Changes

- 9f720bd: `cache.lock(key, ttlMs, fn, { renew: true })` extends the lock every `ttlMs / 2` while `fn` runs, so long work keeps it and a crashed holder's lock still expires. Stores implement `extendIfEquals(key, value, ttlMs)` (redis, postgres and memory do); a custom `CacheStore` must add it.
  
  Schedules no longer overlap themselves across processes: when the schedule lock can hold (`lock`, as `cache` does), a run holds a renewed `schedule:<name>:running` lock, and a tick that finds the previous run still going is skipped and logged. Ticks are still claimed once each, as before.

## 0.1.0

### Minor Changes

- b9fca8f: `@tatara/cache`: one cache contract (`get/set/del/delPrefix/add/take/increment/wrap/lock`, `orgKey`/`userKey`) with memory, Redis and Postgres (unlogged table in its own schema) drivers. New `cache` add-on: `cache` from `#core/cache/index`, picked with `CACHE_DRIVER` (Redis by default, memory in tests).
