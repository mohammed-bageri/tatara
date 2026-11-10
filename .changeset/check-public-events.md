---
"@tatara/cli": minor
---

`tatara check` treats a module's `events/` as public, next to `services/` and `db/`: other modules import its domain event definitions to subscribe to them.
