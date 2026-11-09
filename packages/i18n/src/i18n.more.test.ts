import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createI18n,
	loadDictionaries,
	withEnumLabels,
	withEnumLabelsAll,
	zodErrorMap,
} from "./index.ts";

const i18n = createI18n({
	dictionaries: {
		en: {
			common: {
				greet: "Hi {{ name }}",
				items_one: "{{count}} item",
				items_other: "{{count}} items",
				items_zero: "No items",
			},
			validation: { required: "Required", too_small: "At least {{minimum}}" },
			jobs: { status: { DRAFT: "Draft" } },
		},
		ar: {
			common: { greet: "مرحبا {{name}}", items_two: "عنصران", items_other: "{{count}} عناصر" },
			validation: { required: "مطلوب" },
		},
	},
	defaultLanguage: "en",
});

describe("translator", () => {
	it("reads namespaced keys with {{var}} interpolation", () => {
		const t = i18n.translator("ar");
		expect(t("common:greet", { name: "Ada" })).toBe("مرحبا Ada");
		expect(i18n.t("en", "common.greet", "", { name: "Ada" })).toBe("Hi Ada");
	});

	it("picks plural forms with the language's rules, and _zero for 0", () => {
		expect(i18n.translator("en")("common:items", { count: 1 })).toBe("1 item");
		expect(i18n.translator("en")("common:items", { count: 3 })).toBe("3 items");
		expect(i18n.translator("en")("common:items", { count: 0 })).toBe("No items");
		expect(i18n.translator("ar")("common:items", { count: 2 })).toBe("عنصران");
		expect(i18n.translator("ar")("common:items", { count: 100 })).toBe("100 عناصر");
	});

	it("falls back to the default language, then defaultValue, then the key", () => {
		const t = i18n.translator("fr");
		expect(t("jobs:status.DRAFT")).toBe("Draft");
		expect(i18n.translator("ar")("jobs:status.DRAFT")).toBe("Draft");
		expect(t("jobs:missing", { defaultValue: "Other" })).toBe("Other");
		expect(t("jobs:missing")).toBe("jobs:missing");
	});

	it("answers exists, resource, resolveLanguage and pick", () => {
		expect(i18n.exists("validation:too_small", "ar")).toBe(true);
		expect(i18n.exists("validation:nope")).toBe(false);
		expect(i18n.resource("ar", "validation:too_small")).toBeUndefined();
		expect(i18n.resource("en", "jobs:status")).toEqual({ DRAFT: "Draft" });
		expect(i18n.resolveLanguage("fr")).toBe("en");
		expect(i18n.pick("ar", { en: "Name", ar: "الاسم" })).toBe("الاسم");
		expect(i18n.pick("ar", { en: "Name", ar: "" })).toBe("Name");
	});
});

describe("detection options", () => {
	function app(options: Parameters<typeof createI18n>[0]["detection"], prefer?: string) {
		const local = createI18n({
			dictionaries: { en: {}, ar: {} },
			defaultLanguage: "en",
			detection: options,
		});
		const app = new Hono<{ Variables: { language: string } }>();
		app.use(local.detectLanguage);
		if (prefer) app.use(local.preferLanguage(() => prefer));
		app.get("/", (c) => c.text(`${c.get("language")}:${local.currentLanguage()}`));
		return app;
	}

	it("reads a named cookie and persists the detected language", async () => {
		const res = await app({ cookie: "language", persist: { maxAge: 60, httpOnly: true } }).request(
			"/",
			{
				headers: { "accept-language": "ar" },
			},
		);
		expect(await res.text()).toBe("ar:ar");
		expect(res.headers.get("set-cookie")).toMatch(/^language=ar; Max-Age=60;.*HttpOnly/);
		const again = await app({ cookie: "language", persist: {} }).request("/", {
			headers: { cookie: "language=ar" },
		});
		expect(again.headers.get("set-cookie")).toBeNull();
	});

	it("ranks Accept-Language by q", async () => {
		const res = await app({}).request("/", {
			headers: { "accept-language": "en;q=0.2, ar;q=0.8" },
		});
		expect(await res.text()).toBe("ar:ar");
	});

	it("prefers the stored preference unless ?lang asks for a language", async () => {
		expect(await (await app({}, "ar").request("/")).text()).toBe("ar:ar");
		expect(await (await app({}, "ar").request("/?lang=en")).text()).toBe("en:en");
		expect(await (await app({}, "fr").request("/")).text()).toBe("en:en");
	});
});

describe("zodErrorMap", () => {
	it("localises zod issues in the current language and leaves untranslated kinds to zod", () => {
		z.config({ customError: zodErrorMap(i18n) });
		try {
			const schema = z.object({ name: z.string(), tags: z.array(z.string()).min(2) });
			const issues = (lang: string) =>
				i18n.withLanguage(lang, () =>
					schema.safeParse({ tags: [] }).error?.issues.map((i) => i.message),
				);
			expect(issues("ar")).toEqual(["مطلوب", "At least 2"]);
			expect(issues("en")).toEqual(["Required", "At least 2"]);
			expect(z.email().safeParse("x").error?.issues[0]?.message).toBe("Invalid email address");
		} finally {
			z.config({ customError: undefined });
		}
	});

	it("takes full keys per kind", () => {
		const map = zodErrorMap(i18n, { keys: { required: "jobs:status.DRAFT" } });
		expect(map({ code: "invalid_type", input: undefined })).toEqual({ message: "Draft" });
	});
});

describe("loadDictionaries", () => {
	it("reads <lang>/<ns>.json, discovering languages and namespaces", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tatara-i18n-"));
		mkdirSync(join(dir, "en"));
		mkdirSync(join(dir, "ar"));
		writeFileSync(join(dir, "en", "common.json"), JSON.stringify({ hi: "Hi" }));
		writeFileSync(join(dir, "en", "jobs.json"), JSON.stringify({ x: "X" }));
		writeFileSync(join(dir, "ar", "common.json"), JSON.stringify({ hi: "أهلا" }));
		const missing: string[] = [];
		const dictionaries = await loadDictionaries({
			dir,
			onMissing: (l, n) => missing.push(`${l}/${n}`),
		});
		expect(dictionaries).toEqual({
			ar: { common: { hi: "أهلا" }, jobs: {} },
			en: { common: { hi: "Hi" }, jobs: { x: "X" } },
		});
		expect(missing).toEqual(["ar/jobs"]);
		const only = await loadDictionaries({ dir, languages: ["en"], namespaces: ["common"] });
		expect(only).toEqual({ en: { common: { hi: "Hi" } } });
	});
});

describe("withEnumLabels", () => {
	it("adds <field>_label for set enum fields", () => {
		const t = i18n.translator("en");
		expect(
			withEnumLabels(
				{ status: "DRAFT", kind: null },
				{ status: "jobs:status", kind: "jobs:kind" },
				t,
			),
		).toEqual({
			status: "DRAFT",
			kind: null,
			status_label: "Draft",
		});
		expect(withEnumLabelsAll([{ status: "DRAFT" }], { status: "jobs:status" }, t)).toEqual([
			{ status: "DRAFT", status_label: "Draft" },
		]);
	});
});

describe("context and language codes", () => {
	const app18n = createI18n({
		dictionaries: {
			en: {
				common: {
					trigger: "On the date",
					trigger_weekly: "Every week",
					trigger_weekly_other: "Every {{count}} weeks",
				},
			},
			ar: { common: { trigger: "في التاريخ" } },
		},
		defaultLanguage: "en",
		detection: { query: "lang", cookie: "language" },
	});

	it("tries key_<context> before key, plural forms first", () => {
		const t = app18n.translator("en");
		expect(t("common.trigger", { context: "weekly" })).toBe("Every week");
		expect(t("common.trigger", { context: "weekly", count: 3 })).toBe("Every 3 weeks");
		expect(t("common.trigger", { context: "monthly" })).toBe("On the date");
		expect(t("common.trigger")).toBe("On the date");
	});

	it("matches a language code in any case, and a region to its base language", async () => {
		const app = new Hono<{ Variables: { language: string } }>();
		app.use(app18n.detectLanguage);
		app.get("/", (c) => c.text(c.get("language")));
		const lang = async (init: RequestInit, path = "/") => (await app.request(path, init)).text();
		expect(await lang({}, "/?lang=AR")).toBe("ar");
		expect(await lang({}, "/?lang=ar-SA")).toBe("ar");
		expect(await lang({ headers: { cookie: "language=AR" } })).toBe("ar");
		expect(await lang({}, "/?lang=fr")).toBe("en");
		expect(app18n.translator("AR")("common.trigger")).toBe("في التاريخ");
	});
});
