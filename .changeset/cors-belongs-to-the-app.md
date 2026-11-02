---
"@tatara/http": patch
"@tatara/cli": patch
---

CORS belongs to the app: generated apps call Hono's `cors()` in `src/apps/http.ts`, with `corsOrigin` for exact origins and `*.` patterns, so the allowed headers and origins are theirs to change. `createApp`'s `cors` option is optional and deprecated (existing apps keep working), and the `allowOrigin` option from 0.1.3 is gone: an origin kept in the database is now just a check inside the app's `origin` function.
