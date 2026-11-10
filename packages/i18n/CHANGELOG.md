# @tatara/i18n

## 0.5.0

### Minor Changes

- 7f7c89f: `createI18n({ defaultNamespace })`: a key without a namespace is looked up there after the top level. A variable passed as null or undefined renders empty (one never passed keeps its placeholder). A translator gives a missing key as its name without the namespace, as i18next does.

## 0.4.0

### Minor Changes

- a87e93e: Core holds no tables: new apps keep authz and events in src/modules/authz and src/modules/events, and `tatara upgrade` moves existing apps there (0.20 codemod). `tatara check` lets a module import another module's tables (db/) as well as its services. `createI18n({ searchNamespaces: true })` finds a key without a namespace inside every namespace, so modules own their error strings. `tatara new --help` lists every add-on.

## 0.3.1

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.

## 0.3.0

### Minor Changes

- 5c81aca: Translations take a `context` (`key_<context>` is tried before `key`, plural forms first). Language codes from the query, cookie, stored preference or `translator()` match in any case, and a region falls back to its base language (`AR`, `ar-SA` → `ar`), as Accept-Language already did.

## 0.2.0

### Minor Changes

- 279dda4: `@tatara/i18n`: namespaced keys (`t(lang, "errors:notFound")` reads the `errors` top-level key), `{{var}}` interpolation next to `{var}`, plural forms picked by `count` (`key_zero`, `key_one`, `key_other`, … via `Intl.PluralRules`), `translator(lang)` (i18next-style `t(key, { …vars, defaultValue })`), `exists`, `resource`, `resolveLanguage`, `pick`, `currentLanguage` / `withLanguage` (AsyncLocalStorage, set by `detectLanguage`), `preferLanguage(c => …)` for a stored user preference, `detection` options (query / cookie names, Accept-Language, `persist` cookie), `loadDictionaries({ dir })` for `locales/<lang>/<ns>.json`, `zodErrorMap(i18n, { prefix, keys })` and `withEnumLabels`. Behaviour changes: a `:` in a key now separates the namespace, and Accept-Language is ranked by `q` instead of read in order.
