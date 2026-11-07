---
"@tatara/authz": minor
"@tatara/cli": minor
---

Roles carry `labels`, their name and description in other languages (`{ ar: { name, description } }`), on custom roles and built-in ones (`systemRoles[].labels`, kept in sync). New authz tables get a nullable `labels` column; existing tables work without it until an app passes labels. `addOverlay` now checks `canHoldRoles` too.
