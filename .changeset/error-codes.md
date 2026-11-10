---
"@tatara/http": minor
"@tatara/realtime": minor
"@tatara/cli": minor
"@tatara/authz": patch
---

4xx errors take `(message?, { code?, details? })`: a specific code for the client (translated as `errors.<code>`), and details. NotFoundError's argument is its message now ("Job not found"); `tatara upgrade` rewrites existing calls (0.21 codemod). `realtime.attach(server, { channels, checkPermission, featureAllowed })` takes the channel checks, for apps whose authz lives in a module.
