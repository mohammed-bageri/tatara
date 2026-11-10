---
"@tatara/auth": minor
"@tatara/cli": patch
---

`currentOrgId(c)` gives the org the request acts in. `requireOrg` answers a non-member 403 `NOT_ORG_MEMBER` (was `FORBIDDEN`), so clients can tell it from a missing permission; the i18n template translates it.
