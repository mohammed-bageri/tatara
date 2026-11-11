---
"@tatara/cli": minor
---

`tatara check`: no `../` in side-effect imports, `vi.mock` or `vi.importActual`; `*.test.ts` only under a `tests/` folder (`tests-location`); a module's folders must be ones tatara discovers or a `registries` glob's folder (`module-folders`). A routes file's `defineRoutes` `app` and `basePath` must be string literals (`literal-base-path`), so `duplicate-base-path` sees every mount.
