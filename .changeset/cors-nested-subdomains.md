---
"@tatara/http": minor
---

`corsOrigin(origins, { nestedSubdomains: true })`: a `https://*.example.com` pattern also matches deeper subdomains (`a.b.example.com`). Off by default; still https-only, dot-bounded, apex not included.
