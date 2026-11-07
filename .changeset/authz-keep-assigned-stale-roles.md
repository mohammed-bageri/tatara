---
"@tatara/authz": minor
---

`syncSystemRoles` keeps a built-in role the code no longer has while a member still holds it (reported in `kept`, and `authz:sync-permissions` warns) instead of deleting it with that member's access. Stores implement `roleAssignmentCount(roleId)` (drizzle, prisma and memory do); a custom `AuthzStore` must add it.
