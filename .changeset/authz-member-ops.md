---
"@tatara/authz": minor
---

Member and role operations apps had to write themselves:
- `setMemberRoles` replaces a member's roles, writing and auditing only the difference, in one step.
- `addRolesToMembers` adds roles to many members and reports the ones skipped.
- `duplicateRole` copies a built-in or custom role.
- `listUsersWithPermission` lists everyone a check would allow, read at decision time. It can take the caller's transaction, and needs the new `listMembers` option when a members-held role grants the permission.
- `listAudit` pages with a cursor.
- `syncSystemRoles` also deletes built-in roles the code no longer has, and reports them in `deleted`.
- `createAuthz({ canHoldRoles })` lets the app refuse users who may not hold org roles.
- `authzPlugin({ creatorRole })` takes several roles.

`AuthzStore` gains `replaceMemberRoles` and `permissionHolders`, and `listAudit` takes a cursor. The drizzle, prisma and memory stores implement them; a custom store must add them.
