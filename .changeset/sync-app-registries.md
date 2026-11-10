---
"@tatara/cli": minor
---

tatara.json `registries`: app-declared discovery kinds. `tatara sync` writes each one's matched files to `src/generated/<name>.ts` as one typed list: the default, namespace (`"*"`) or a named export of each file; `each: "array" | "record"` for files that export a list or a map; `shape: "entries"` for `{ owner, file, value }` rows; `unique` for a duplicate check when the module loads.
