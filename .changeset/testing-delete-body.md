---
"@tatara/testing": patch
---

`client(app).delete(path, { body })` now supports request bodies. `RequestOptions` gains `body?: unknown`, used by `delete` and ignored by `get`.
