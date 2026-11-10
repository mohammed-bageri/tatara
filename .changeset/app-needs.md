---
"@tatara/events": minor
"@tatara/ai": minor
"@tatara/http": minor
"@tatara/db": patch
---

Event definitions take an optional `label` (how a UI names the event). `isBlockedResponse(error)` from @tatara/ai tells a safety refusal from a failed request. `clientIp(c, { trustedHeader })` reads the address the app's own proxy sets (x-real-ip, cf-connecting-ip). More tests for the database error helpers.
