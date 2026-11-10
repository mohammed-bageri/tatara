---
"@tatara/auth": minor
---

`createAuthInstance` options `clientIp` (`{ resolve, header?, unresolved? }`: better-auth's rate limits and session IPs key on the address the app resolved, set by the new `handleRequest(c)`) and `onUnauthorized`; it also returns `attachSession` (`c.var.session` / `c.var.user`) and `requireSession` (401 without a user or while an admin-plugin ban holds). New exports `isBannedNow`, `withClientIpHeader`, `SessionEnv`, `ClientIpOptions`.

`sessionPrincipal` (so `attachPrincipal`, `requireAuth()` and `requireOrg()`) no longer gives a principal to a user whose admin-plugin ban is in force.
