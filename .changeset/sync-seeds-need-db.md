---
"@tatara/cli": patch
---

`tatara sync` writes `src/generated/seeds.ts` only when the app has `@tatara/db` (installed or ejected), since the seed runner and `SeedDefinition` are its. An app with a database on its own client no longer gets a seeds list that cannot compile.
