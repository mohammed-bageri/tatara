---
"@tatara/i18n": minor
---

Translations take a `context` (`key_<context>` is tried before `key`, plural forms first). Language codes from the query, cookie, stored preference or `translator()` match in any case, and a region falls back to its base language (`AR`, `ar-SA` → `ar`), as Accept-Language already did.
