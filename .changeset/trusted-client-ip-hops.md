---
"@tatara/http": patch
---

`trustedClientIp` counts an empty X-Forwarded-For entry as a hop and returns only a valid IP, so a trailing empty entry no longer hands trust to a client-sent address.
