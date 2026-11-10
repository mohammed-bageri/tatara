---
"@tatara/i18n": minor
---

`createI18n({ defaultNamespace })`: a key without a namespace is looked up there after the top level. A variable passed as null or undefined renders empty (one never passed keeps its placeholder). A translator gives a missing key as its name without the namespace, as i18next does.
