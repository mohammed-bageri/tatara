---
"@tatara/cli": patch
"@tatara/http": patch
---

**@tatara/cli**: Fix identifier collision in `tatara sync` when module names match kind folder names. Previously, all path segments matching kind names (routes, events, notifications, consumers, etc.) were filtered out, causing collisions when a module itself was named after a kind. Now only the kind folder in its expected position (`modules/<name>/<kind>` or `core/<area>/<kind>`) is removed from identifiers, preserving module names.

**@tatara/http**: Fix `createPagination({ navigation: true })` to require `hasNext` and `hasPrev` as booleans in both the zod schema and TypeScript types. Previously these fields were optional in the types even when navigation was true.

Note: Existing apps using `tatara sync` may see changed identifiers in generated files for modules whose names match kind folder names. This is expected and safe (generated files only).
