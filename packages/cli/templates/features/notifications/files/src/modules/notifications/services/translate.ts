import type { Translate } from "@tatara/notifications";
import type { Context } from "hono";

/** The language an inbox is read in; the i18n add-on makes it the request's. */
export const readerLanguage = (_c: Context): string => "en";

/** How notification keys become text; without the i18n add-on, the stored text or the key. */
export const translate: Translate = (_language, _key, _params, fallback) => fallback;
