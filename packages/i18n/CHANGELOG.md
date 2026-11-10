# @tatara/i18n

## 0.3.1

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.

## 0.3.0

### Minor Changes

- 5c81aca: Translations take a `context` (`key_<context>` is tried before `key`, plural forms first). Language codes from the query, cookie, stored preference or `translator()` match in any case, and a region falls back to its base language (`AR`, `ar-SA` → `ar`), as Accept-Language already did.

## 0.2.0

### Minor Changes

- 279dda4: `@tatara/i18n`: namespaced keys (`t(lang, "errors:notFound")` reads the `errors` top-level key), `{{var}}` interpolation next to `{var}`, plural forms picked by `count` (`key_zero`, `key_one`, `key_other`, … via `Intl.PluralRules`), `translator(lang)` (i18next-style `t(key, { …vars, defaultValue })`), `exists`, `resource`, `resolveLanguage`, `pick`, `currentLanguage` / `withLanguage` (AsyncLocalStorage, set by `detectLanguage`), `preferLanguage(c => …)` for a stored user preference, `detection` options (query / cookie names, Accept-Language, `persist` cookie), `loadDictionaries({ dir })` for `locales/<lang>/<ns>.json`, `zodErrorMap(i18n, { prefix, keys })` and `withEnumLabels`. Behaviour changes: a `:` in a key now separates the namespace, and Accept-Language is ranked by `q` instead of read in order.
