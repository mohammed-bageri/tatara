---
"@tatara/cache": minor
"@tatara/jobs": minor
---

`cache.lock(key, ttlMs, fn, { renew: true })` extends the lock every `ttlMs / 2` while `fn` runs, so long work keeps it and a crashed holder's lock still expires. Stores implement `extendIfEquals(key, value, ttlMs)` (redis, postgres and memory do); a custom `CacheStore` must add it.

Schedules no longer overlap themselves across processes: when the schedule lock can hold (`lock`, as `cache` does), a run holds a renewed `schedule:<name>:running` lock, and a tick that finds the previous run still going is skipped and logged. Ticks are still claimed once each, as before.
