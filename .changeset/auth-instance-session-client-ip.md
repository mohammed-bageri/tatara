---
"@tatara/auth": minor
---

`createAuthInstance` options `clientIp` (`{ resolve, header?, unresolved? }`: better-auth's rate limits and session IPs key on the address the app resolved, set by the new `handleRequest(c)`) and `onUnauthorized`; it also returns `attachSession` (`c.var.session` / `c.var.user`) and `requireSession` (401 without a user or while an admin-plugin ban holds). New exports `isBannedNow`, `withClientIpHeader`, `SessionEnv`, `ClientIpOptions`.
