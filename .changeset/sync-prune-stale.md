---
"@tatara/cli": patch
---

`tatara sync` removes files in src/generated that an earlier sync wrote and nothing produces any more (only files with the sync header).
