---
"@tatara/i18n": minor
---

`@tatara/i18n`: namespaced keys (`t(lang, "errors:notFound")` reads the `errors` top-level key), `{{var}}` interpolation next to `{var}`, plural forms picked by `count` (`key_zero`, `key_one`, `key_other`, … via `Intl.PluralRules`), `translator(lang)` (i18next-style `t(key, { …vars, defaultValue })`), `exists`, `resource`, `resolveLanguage`, `pick`, `currentLanguage` / `withLanguage` (AsyncLocalStorage, set by `detectLanguage`), `preferLanguage(c => …)` for a stored user preference, `detection` options (query / cookie names, Accept-Language, `persist` cookie), `loadDictionaries({ dir })` for `locales/<lang>/<ns>.json`, `zodErrorMap(i18n, { prefix, keys })` and `withEnumLabels`. Behaviour changes: a `:` in a key now separates the namespace, and Accept-Language is ranked by `q` instead of read in order.
