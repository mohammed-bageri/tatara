---
"@tatara/core": patch
---

Shutdown exits 1 when any shutdown hook failed (it exited 0 on a signal), so a process supervisor sees a failed cleanup.
