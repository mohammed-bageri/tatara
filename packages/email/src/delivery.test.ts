import { createHmac, hkdfSync } from "node:crypto";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
	createEmailButton,
	createLanguageResolver,
	createMailgunWebhook,
	createSuppressionList,
	createUnsubscribePage,
	createUnsubscribeTokens,
	emailHash,
	escapeHtml,
	hashVariables,
	type Mailer,
	memoryEmailQueueStore,
	memorySuppressionStore,
	missingVariables,
	substitutePlaceholders,
	textDirection,
	wrapEmailContent,
} from "./index.ts";

const logger = pino({ level: "silent" });

describe("the suppression list", () => {
	it("keys by a normalised address hash and keeps the first reason", async () => {
		const store = memorySuppressionStore();
		const list = createSuppressionList(store);
		await list.suppress({ orgId: "o", address: " Ada@Example.com", reason: "bounced" });
		await list.suppress({ orgId: "o", address: "ada@example.com", reason: "unsubscribed" });
		expect(store.rows).toEqual([
			{ orgId: "o", hash: emailHash("ada@example.com"), reason: "bounced", sourceJobId: null },
		]);
		expect(JSON.stringify(store.rows)).not.toContain("ada@");
		expect(await list.reason("o", "ADA@example.com")).toBe("bounced");
		expect(await list.reason("other-org", "ada@example.com")).toBeNull();
		expect(await list.reasons("o", ["ada@example.com", "bob@example.com"])).toEqual(
			new Map([["ada@example.com", "bounced"]]),
		);
	});

	it("sends unless the recipient is suppressed", async () => {
		const list = createSuppressionList(memorySuppressionStore());
		const mailer: Mailer = { send: vi.fn(async () => ({ id: "<1>" })) };
		await list.suppress({ orgId: "o", address: "a@x", reason: "complained" });
		expect(await list.send(mailer, "o", { to: "a@x", subject: "s", text: "t" })).toEqual({
			suppressed: "complained",
		});
		expect(await list.send(mailer, "o", { to: "b@x", subject: "s", text: "t" })).toEqual({
			id: "<1>",
		});
		expect(mailer.send).toHaveBeenCalledTimes(1);
	});
});

describe("unsubscribe tokens", () => {
	const tokens = createUnsubscribeTokens({ secret: "app-secret" });
	const id = "6f1c2b0e-5d0a-4c4e-9a52-3b1f1f2d9e10";

	it("verify what they sign and nothing else", () => {
		const token = tokens.sign(id);
		expect(tokens.verify(token)).toBe(id);
		expect(tokens.verify(`${id}.${"A".repeat(43)}`)).toBeNull();
		expect(tokens.verify(token.replace(id, "6f1c2b0e-5d0a-4c4e-9a52-3b1f1f2d9e11"))).toBeNull();
		expect(tokens.verify("no-dot")).toBeNull();
		expect(tokens.verify(`../x.${token.split(".")[1]}`)).toBeNull();
		expect(createUnsubscribeTokens({ secret: "other" }).verify(token)).toBeNull();
	});

	it("match tokens already sent under an app's own info string", () => {
		// the scheme apps used before: HKDF(secret, "", info) then HMAC("unsubscribe:v1:" + id)
		const key = Buffer.from(hkdfSync("sha256", "app-secret", "", "sana-email-unsubscribe-v1", 32));
		const legacy = `${id}.${createHmac("sha256", key).update(`unsubscribe:v1:${id}`).digest("base64url")}`;
		const compatible = createUnsubscribeTokens({
			secret: "app-secret",
			info: "sana-email-unsubscribe-v1",
		});
		expect(compatible.sign(id)).toBe(legacy);
		expect(compatible.verify(legacy)).toBe(id);
	});

	it("drive the unsubscribe page through the queue's jobs", async () => {
		const store = memoryEmailQueueStore();
		const suppressions = createSuppressionList(memorySuppressionStore());
		const at = new Date();
		const jobId = await store.insert({
			orgId: "o",
			templateKey: "k",
			recipient: "ada@example.com",
			variables: {},
			idempotencyKey: "i",
			subjectOverride: null,
			status: "sent",
			attempts: 1,
			maxAttempts: 5,
			scheduledFor: at,
			nextAttemptAt: at,
			lastError: null,
			entityType: null,
			entityId: null,
			language: "en",
			replyTo: null,
			unsubscribeLink: true,
			createdAt: at,
			updatedAt: at,
			processedAt: at,
		});
		const page = createUnsubscribePage({ tokens, store, suppressions });
		const token = tokens.sign(jobId!);
		expect((await page.status(token))?.unsubscribed).toBe(false);
		expect((await page.unsubscribe(token))?.id).toBe(jobId);
		expect((await page.status(token))?.unsubscribed).toBe(true);
		expect(await suppressions.reason("o", "ada@example.com")).toBe("unsubscribed");
		expect(await page.status(tokens.sign("unknown"))).toBeNull();
		expect(await page.unsubscribe("forged.token")).toBeNull();
	});
});

describe("the Mailgun webhook", () => {
	const signingKey = "whsec";
	const now = new Date("2026-01-01T00:00:00Z");
	const signed = (eventData: Record<string, unknown>, token = "tok-1", at = now) => {
		const timestamp = String(Math.floor(at.getTime() / 1000));
		return {
			signature: {
				timestamp,
				token,
				signature: createHmac("sha256", signingKey)
					.update(timestamp + token)
					.digest("hex"),
			},
			"event-data": eventData,
		};
	};

	async function setup() {
		const store = memoryEmailQueueStore();
		const suppressionStore = memorySuppressionStore();
		const suppressions = createSuppressionList(suppressionStore);
		const seen = new Set<string>();
		const replay = {
			add: vi.fn(async (key: string) => {
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			}),
			del: vi.fn(async (...keys: string[]) => {
				for (const k of keys) seen.delete(k);
			}),
		};
		await store.log({
			orgId: "org-1",
			jobId: "job-1",
			templateKey: "k",
			recipient: "ada@example.com",
			subject: "s",
			status: "sent",
			providerMessageId: "<m1@mg>",
			variablesHash: "h",
			errorMessage: null,
			sentAt: now,
		});
		const webhook = createMailgunWebhook({
			signingKey,
			store,
			suppressions,
			replay,
			logger,
			now: () => now,
		});
		return { webhook, suppressions, suppressionStore, replay };
	}

	it("suppresses a hard bounce found by message id", async () => {
		const { webhook, suppressions, suppressionStore } = await setup();
		const result = await webhook.handle(
			signed({
				event: "failed",
				severity: "permanent",
				recipient: "ada@example.com",
				message: { headers: { "message-id": "m1@mg" } },
			}),
		);
		expect(result).toEqual({ status: 200, outcome: "suppressed" });
		expect(await suppressions.reason("org-1", "ada@example.com")).toBe("bounced");
		expect(suppressionStore.rows[0]?.sourceJobId).toBe("job-1");
	});

	it("ignores temporary failures, unknown messages and a different recipient", async () => {
		const { webhook } = await setup();
		const headers = { headers: { "message-id": "m1@mg" } };
		const cases = [
			{ event: "failed", severity: "temporary", recipient: "ada@example.com", message: headers },
			{ event: "delivered", recipient: "ada@example.com", message: headers },
			{ event: "complained", recipient: "ada@example.com", message: { headers: {} } },
			{ event: "complained", recipient: "eve@example.com", message: headers },
			{
				event: "complained",
				recipient: "ada@example.com",
				"user-variables": { tatara_job_id: "x" },
			},
		];
		for (const [i, data] of cases.entries())
			expect(await webhook.handle(signed(data, `t${i}`))).toEqual({
				status: 200,
				outcome: "ignored",
			});
	});

	it("refuses bad, stale and replayed signatures", async () => {
		const { webhook } = await setup();
		const body = signed({ event: "delivered" });
		expect(await webhook.handle(body)).toMatchObject({ status: 200 });
		expect(await webhook.handle(body)).toEqual({ status: 406, reason: "replayed" });
		const stale = signed({}, "t2", new Date(now.getTime() - 16 * 60 * 1000));
		expect(await webhook.handle(stale)).toEqual({ status: 406, reason: "invalid" });
		const forged = signed({}, "t3");
		forged.signature.signature = "0".repeat(64);
		expect(await webhook.handle(forged)).toEqual({ status: 406, reason: "invalid" });
		expect(await webhook.handle({ nope: true })).toEqual({ status: 406, reason: "invalid" });
	});

	it("answers 404 without a signing key", async () => {
		const webhook = createMailgunWebhook({
			signingKey: undefined,
			store: memoryEmailQueueStore(),
			suppressions: createSuppressionList(memorySuppressionStore()),
			replay: { add: async () => true, del: async () => {} },
			logger,
		});
		expect(await webhook.handle({})).toEqual({ status: 404 });
	});

	it("frees the token when recording fails, so Mailgun's retry is accepted", async () => {
		const { webhook, replay, suppressions } = await setup();
		vi.spyOn(suppressions, "suppress").mockRejectedValueOnce(new Error("db down"));
		const body = signed({
			event: "complained",
			recipient: "ada@example.com",
			message: { headers: { "message-id": "m1@mg" } },
		});
		await expect(webhook.handle(body)).rejects.toThrow("db down");
		expect(replay.del).toHaveBeenCalledWith("email:mailgun-webhook:tok-1");
		expect(await webhook.handle(body)).toEqual({ status: 200, outcome: "suppressed" });
	});
});

describe("the layout", () => {
	const branding = { companyName: "Acme <Co>", supportEmail: "help@acme.test" };

	it("is RTL for Arabic, escapes branding and adds the unsubscribe footer", () => {
		const html = wrapEmailContent("<p>body</p>", branding, {
			language: "ar",
			unsubscribeUrl: "https://x/u?a=1&b=2",
			year: 2026,
		});
		expect(html).toContain('<html lang="ar" dir="rtl">');
		expect(html).toContain("<p>body</p>");
		expect(html).toContain("Acme &lt;Co&gt; &copy; 2026");
		expect(html).toContain("للدعم:");
		expect(html).toContain('href="https://x/u?a=1&amp;b=2"');
		expect(html).toContain("إلغاء الاشتراك");
	});

	it("is LTR in English, with the initial when there is no logo and no unsubscribe link", () => {
		const html = wrapEmailContent("x", { ...branding, primaryColor: "#123456" });
		expect(html).toContain('dir="ltr"');
		expect(html).toContain(">A</span>");
		expect(html).toContain("#123456");
		expect(html).not.toContain("Unsubscribe");
		expect(textDirection("he-IL")).toBe("rtl");
		expect(createEmailButton("Go <now>", "https://x")).toContain("Go &lt;now&gt;");
	});
});

describe("placeholders", () => {
	it("substitute variables of each kind", () => {
		const out = substitutePlaceholders(
			"{{name}} {{n}} {{ok}} {{when}} {{obj}} {{missing}}!",
			{ name: "Ada", n: 3, ok: true, when: new Date("2026-03-05T12:00:00Z"), obj: { a: 1 } },
			{ language: "en", formatDate: (d) => d.toISOString().slice(0, 10) },
		);
		expect(out).toBe('Ada 3 true 2026-03-05 {"a":1} !');
		expect(substitutePlaceholders(null, {})).toBe("");
		expect(escapeHtml(`<a href="x">'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;");
		expect(missingVariables({ a: 1, b: null }, ["a", "b", "c"])).toEqual(["b", "c"]);
		expect(hashVariables({ b: 1, a: 2 })).toBe(hashVariables({ a: 2, b: 1 }));
	});
});

describe("createLanguageResolver", () => {
	it("asks each source by priority, then falls back", async () => {
		const resolve = createLanguageResolver<{ userId?: string }>([
			{ priority: 10, resolve: () => "fr" },
			{ priority: 1, resolve: (_o, _a, ref) => (ref.userId ? "ar" : null) },
		]);
		expect(await resolve("o", "a@x", { userId: "u" })).toBe("ar");
		expect(await resolve("o", "a@x")).toBe("fr");
		expect(await createLanguageResolver([], { fallback: "de" })("o", "a@x")).toBe("de");
	});
});
