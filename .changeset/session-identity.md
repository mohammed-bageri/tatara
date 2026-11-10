---
"@tatara/auth": minor
---

Add session identity to sessionPrincipal claims. Claims now include `session: { id, impersonatedBy, expiresAt }` for binding realtime resources and detecting staff impersonation. User fields remain unchanged.
