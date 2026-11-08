# @tatara/i18n

Part of [tatara](https://github.com/mohammed-bageri/tatara-cli). Dictionaries, `t()`, plurals,
language detection for Hono and localised zod messages. No i18n library underneath.

```ts
import { createI18n, loadDictionaries, zodErrorMap } from "@tatara/i18n";
import { z } from "zod";

const i18n = createI18n({
	// { en: { common: {…}, errors: {…} }, ar: {…} } from locales/<lang>/<ns>.json
	dictionaries: await loadDictionaries({ dir: `${process.cwd()}/locales` }),
	defaultLanguage: "en",
	detection: { cookie: "language", persist: { maxAge: 31_536_000, httpOnly: true, sameSite: "Lax" } },
});

app.use(i18n.detectLanguage); // ?lang, cookie, Accept-Language → c.var.language
app.use(i18n.preferLanguage((c) => c.get("user")?.language)); // unless ?lang is set
z.config({ customError: zodErrorMap(i18n, { prefix: "errors:validation." }) });

const t = i18n.translator(c.get("language"));
t("common:items", { count: 3 }); // items_one / items_other / items_zero
t("errors:notFound", { defaultValue: "Not found" });
```

- Keys are `a.b.c` or `namespace:a.b.c`; a namespace is a top-level key of the dictionary.
- Variables are `{name}` or `{{name}}`; unknown ones are left as written.
- Missing keys fall back to the default language, then `defaultValue` (or `t`'s `fallback`), then the key.
- `currentLanguage()` is the request's language anywhere below `detectLanguage` (the zod map uses it);
  `withLanguage(lang, fn)` sets it for jobs and scripts.
- `zodErrorMap` keys: `required`, `invalid_type`, `too_small`, `too_big`, `invalid_format`,
  `invalid_value`, `custom` under `prefix` (default `validation.`), or full keys via `keys`. A kind
  with no translation keeps zod's message.
- `pick(lang, { en, ar })` chooses a per-language value; `withEnumLabels(row, { status: "jobs:status" }, t)`
  adds `status_label`.
