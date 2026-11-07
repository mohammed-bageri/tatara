import type { Translate } from "@tatara/notifications";
import type { Context } from "hono";
import { t } from "#core/i18n/index";

/** The language an inbox is read in: the request's (`?lang`, the `lang` cookie, Accept-Language). */
export const readerLanguage = (c: Context): string => c.get("language");

/** Notification keys from src/locales, with `{name}` filled from the notification's params. */
export const translate: Translate = (language, key, params, fallback) => t(language, key, fallback, params);
