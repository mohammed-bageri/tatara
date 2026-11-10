---
"@tatara/cli": minor
"@tatara/i18n": minor
"@tatara/authz": minor
"@tatara/events": minor
---

Core holds no tables: new apps keep authz and events in src/modules/authz and src/modules/events, and `tatara upgrade` moves existing apps there (0.20 codemod). `tatara check` lets a module import another module's tables (db/) as well as its services. `createI18n({ searchNamespaces: true })` finds a key without a namespace inside every namespace, so modules own their error strings. `tatara new --help` lists every add-on.
