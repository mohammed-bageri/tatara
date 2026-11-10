---
"@tatara/http": minor
"@tatara/auth": minor
"@tatara/authz": minor
"@tatara/cli": patch
---

`createApp({ redactPath })` hides path secrets from the request log. `requireOrg({ cookie })` falls back to a cookie when the header is missing. `requirePermission` answers 403 `PERMISSION_DENIED` with `details.permission` (was `FORBIDDEN`); the i18n template translates it.
