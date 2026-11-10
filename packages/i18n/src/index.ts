/** @tatara/i18n: dictionaries, `t()`, language detection for Hono and localised zod messages. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Env, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { CookieOptions } from "hono/utils/cookie";

export { withEnumLabels, withEnumLabelsAll } from "./enum-labels.ts";
export { type LoadDictionariesOptions, loadDictionaries } from "./load.ts";
export {
	type ZodErrorMapOptions,
	type ZodIssueLike,
	type ZodMessageKind,
	zodErrorMap,
} from "./zod.ts";

export type Dictionary = { [key: string]: string | Dictionary };

/** Variables for a message; `count` (a number) also picks the plural form (`key_one`, `key_other`, `key_zero`). */
export type TranslateVars = Record<string, unknown>;

/** A translator bound to one language, i18next-style: `t("errors:notFound", { name, count, defaultValue })`. */
export type Translator = (key: string, vars?: TranslateVars & { defaultValue?: string }) => string;

export interface LanguageDetectionOptions {
	/** query parameter, or `false` to ignore the query (default "lang") */
	query?: string | false;
	/** cookie name, or `false` to ignore cookies (default "lang") */
	cookie?: string | false;
	/** read Accept-Language (default true) */
	header?: boolean;
	/** write the detected language to the cookie when it differs, e.g. `{ maxAge: 31536000, httpOnly: true }` */
	persist?: CookieOptions;
}

export interface I18nOptions {
	/** language code → strings, e.g. { en, ar } from src/locales, or `loadDictionaries()` */
	dictionaries: Record<string, Dictionary>;
	defaultLanguage: string;
	detection?: LanguageDetectionOptions;
	/**
	 * A key without a namespace that isn't at the top level is looked up in each namespace too, so
	 * `errors.NOT_IN_STOCK` finds `orders.errors.NOT_IN_STOCK` (modules own their strings).
	 */
	searchNamespaces?: boolean;
	/** where a key without a namespace is looked up after the top level, e.g. "common" */
	defaultNamespace?: string;
}

type Node = string | Dictionary | undefined;

// "ns:a.b" reads dictionary.ns.a.b, so a namespace is just the top-level key.
function path(key: string): string[] {
	const ns = key.indexOf(":");
	const parts = (ns === -1 ? key : key.slice(ns + 1)).split(".");
	return ns === -1 ? parts : [key.slice(0, ns), ...parts];
}

function lookup(dict: Dictionary | undefined, key: string): Node {
	let node: Node = dict;
	for (const part of path(key)) {
		if (!node || typeof node === "string") return undefined;
		node = node[part];
	}
	return node;
}

const VARIABLE = /\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g;

function interpolate(text: string, vars: TranslateVars): string {
	return text.replace(VARIABLE, (match, double?: string, single?: string) => {
		const value = vars[(double ?? single) as string];
		const name = (double ?? single) as string;
		// a variable that wasn't passed stays visible; one passed as null or undefined is empty
		return name in vars ? String(value ?? "") : match;
	});
}

export function createI18n({
	dictionaries,
	defaultLanguage,
	detection = {},
	searchNamespaces = false,
	defaultNamespace,
}: I18nOptions) {
	const languages = Object.keys(dictionaries);
	const storage = new AsyncLocalStorage<string>();
	const pluralRules = new Map<string, Intl.PluralRules>();
	const queryKey = detection.query ?? "lang";
	const cookieName = detection.cookie ?? "lang";

	function plural(language: string, count: number): string {
		let rules = pluralRules.get(language);
		if (!rules) {
			rules = new Intl.PluralRules(language);
			pluralRules.set(language, rules);
		}
		return rules.select(count);
	}

	/** The supported language a code names, ignoring case and region ("AR", "ar-SA" → "ar"). */
	function supportedLanguage(code: string | null | undefined): string | undefined {
		const tag = code?.trim().toLowerCase();
		if (!tag) return undefined;
		return (
			languages.find((l) => l.toLowerCase() === tag) ??
			languages.find((l) => l.toLowerCase() === tag.split("-")[0])
		);
	}

	/** `language` when it is supported (any case or region), otherwise the default language. */
	function resolveLanguage(language: string | null | undefined): string {
		return supportedLanguage(language) ?? defaultLanguage;
	}

	/** `key` in one language's dictionary: context and plural forms first. */
	function findIn(
		lang: string,
		key: string,
		count: unknown,
		context?: unknown,
	): string | undefined {
		const dict = dictionaries[lang];
		// a context ("male", "weekly") tries `key_<context>` before `key`
		const bases = typeof context === "string" && context ? [`${key}_${context}`, key] : [key];
		for (const base of bases) {
			if (typeof count === "number") {
				const forms = count === 0 ? ["zero", plural(lang, count)] : [plural(lang, count)];
				for (const form of forms) {
					const text = lookup(dict, `${base}_${form}`);
					if (typeof text === "string") return text;
				}
			}
			const text = lookup(dict, base);
			if (typeof text === "string") return text;
		}
		return undefined;
	}

	function find(
		language: string,
		key: string,
		count: unknown,
		context?: unknown,
	): string | undefined {
		for (const lang of language === defaultLanguage ? [language] : [language, defaultLanguage]) {
			const text = findIn(lang, key, count, context);
			if (text !== undefined) return text;
			if (defaultNamespace && !key.includes(":")) {
				const inDefault = findIn(lang, `${defaultNamespace}:${key}`, count, context);
				if (inDefault !== undefined) return inDefault;
			}
			const dict = dictionaries[lang];
			if (!searchNamespaces || !dict || key.includes(":")) continue;
			for (const ns of Object.keys(dict)) {
				if (typeof dict[ns] === "string") continue;
				const nested = findIn(lang, `${ns}:${key}`, count, context);
				if (nested !== undefined) return nested;
			}
		}
		return undefined;
	}

	/** Translates `key` ("errors.NOT_FOUND" or "errors:NOT_FOUND"), falling back to the default language, then `fallback`. */
	function t(language: string, key: string, fallback = key, vars: TranslateVars = {}): string {
		return interpolate(find(language, key, vars.count, vars.context) ?? fallback, vars);
	}

	/** A translator for one language (unsupported → default); missing keys give `defaultValue`, else the key. */
	function translator(language: string | null | undefined): Translator {
		const lang = resolveLanguage(language);
		// a missing key reads as itself without its namespace, as in i18next
		return (key, vars = {}) =>
			t(lang, key, vars.defaultValue ?? key.slice(key.indexOf(":") + 1), vars);
	}

	/** True when `key` has a string in `language` (or the default language). */
	function exists(key: string, language: string = defaultLanguage): boolean {
		return find(resolveLanguage(language), key, undefined) !== undefined;
	}

	/** The raw entry at `key` in one language's dictionary, no fallback: a string, a subtree or undefined. */
	function resource(language: string, key: string): string | Dictionary | undefined {
		return lookup(dictionaries[language], key);
	}

	/** The request's language inside `detectLanguage`/`withLanguage`, else the default language. */
	function currentLanguage(): string {
		return storage.getStore() ?? defaultLanguage;
	}

	/** Runs `fn` with `currentLanguage()` set to `language` (for jobs, CLI, tests). */
	function withLanguage<T>(language: string, fn: () => T): T {
		return storage.run(resolveLanguage(language), fn);
	}

	/** The value for `language` from per-language values (e.g. `{ en: row.nameEn, ar: row.nameAr }`); empty falls back to the default language. */
	function pick(
		language: string,
		values: Partial<Record<string, string | null | undefined>>,
	): string {
		return values[language] || values[defaultLanguage] || "";
	}

	function accepted(header: string): string | undefined {
		const ranked = header
			.split(",")
			.map((part, index) => {
				const [tag = "", ...params] = part.trim().toLowerCase().split(";");
				const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find(Boolean);
				return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
			})
			.filter((entry) => entry.tag && entry.q > 0)
			.sort((a, b) => b.q - a.q || a.index - b.index);
		for (const { tag } of ranked) {
			const match = supportedLanguage(tag);
			if (match) return match;
		}
		return undefined;
	}

	function apply(c: Context, language: string, next: () => Promise<void>) {
		c.set("language", language);
		c.header("content-language", language);
		return storage.run(language, next);
	}

	function explicitQuery(c: Context): string | undefined {
		return supportedLanguage(queryKey ? c.req.query(queryKey) : undefined);
	}

	/** ?lang, then the `lang` cookie, then Accept-Language; sets `c.var.language` and `currentLanguage()`. */
	const detectLanguage = createMiddleware<{ Variables: { language: string } }>(async (c, next) => {
		const fromCookie = cookieName ? getCookie(c, cookieName) : undefined;
		const language =
			explicitQuery(c) ??
			supportedLanguage(fromCookie) ??
			(detection.header === false ? undefined : accepted(c.req.header("accept-language") ?? "")) ??
			defaultLanguage;
		if (detection.persist && cookieName && fromCookie !== language)
			setCookie(c, cookieName, language, detection.persist);
		await apply(c, language, next);
	}) as unknown as MiddlewareHandler<Env>;
	// typed as adding nothing to the env, so it mounts on any app whose env has `language`

	/**
	 * Replaces the detected language with `preferred(c)` (e.g. the signed-in user's stored
	 * preference) when it is supported, unless the request asked for one with the query
	 * parameter. Mount after `detectLanguage` and after whatever sets the user.
	 */
	function preferLanguage(
		preferred: (c: Context) => string | null | undefined | Promise<string | null | undefined>,
	): MiddlewareHandler<Env> {
		return async (c, next) => {
			if (explicitQuery(c)) return next();
			const language = supportedLanguage(await preferred(c));
			if (!language) return next();
			await apply(c, language, next);
		};
	}

	return {
		languages,
		defaultLanguage,
		t,
		translator,
		exists,
		resource,
		resolveLanguage,
		currentLanguage,
		withLanguage,
		pick,
		detectLanguage,
		preferLanguage,
	};
}

export type I18n = ReturnType<typeof createI18n>;
