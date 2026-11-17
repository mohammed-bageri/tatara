---
"@tatara/events": minor
---

`events.flush()` resolves once every post-commit publish in flight has settled (`transaction` still returns without waiting), and returns how many it waited on.
