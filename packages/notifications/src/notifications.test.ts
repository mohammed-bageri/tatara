import { createJobs, inlineDriver } from "@tatara/jobs";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createNotifier,
	defineNotification,
	fcmPush,
	localizeNotification,
	memoryNotificationStore,
	type NotificationStore,
	type NotificationsOf,
	type Translate,
	twilioSms,
} from "./index.ts";

const logger = pino({ level: "silent" });

const invoicePaid = defineNotification({
	name: "billing.invoice-paid",
	description: "An invoice was paid",
	schema: z.object({ invoice: z.string(), amount: z.number() }),
	channels: ["in-app", "email", "sms", "push"],
	inApp: ({ invoice }, language) => ({
		title: language === "ar" ? `تم دفع ${invoice}` : `Invoice ${invoice} paid`,
		url: `/invoices/${invoice}`,
	}),
	email: ({ invoice, amount }) => ({ subject: `Invoice ${invoice} paid`, text: `Paid: ${amount}` }),
	sms: ({ invoice }) => `Invoice ${invoice} paid`,
	push: ({ invoice }) => ({ title: `Invoice ${invoice} paid` }),
});
const invoiceDue = defineNotification({
	name: "billing.invoice-due",
	description: "An invoice is due; translated when the inbox is read",
	schema: z.object({ invoice: z.string() }),
	channels: ["in-app"],
	inApp: ({ invoice }) => ({
		titleKey: "billing.due.title",
		bodyKey: "billing.due.body",
		params: { invoice },
		url: `/invoices/${invoice}`,
	}),
});
const notifications = [invoicePaid, invoiceDue] as const;

const dictionaries: Record<string, Record<string, string>> = {
	en: {
		"billing.due.title": "Invoice {invoice} is due",
		"billing.due.body": "Pay {invoice} today",
	},
	ar: {
		"billing.due.title": "الفاتورة {invoice} مستحقة",
		"billing.due.body": "ادفع {invoice} اليوم",
	},
};
const translate: Translate = (language, key, params, fallback) =>
	(dictionaries[language]?.[key] ?? fallback).replace(
		/\{(\w+)\}/g,
		(_, k: string) => params[k] ?? "",
	);

/**
 * A store that dies once in `method`, on email: after a claim takes the channel, or before
 * `markSent` records it. The process crashing there, so no catch block runs.
 */
function crashOnce<S extends NotificationStore>(
	store: S,
	method: "claimChannel" | "claimPending" | "markSent",
) {
	const real = store[method]?.bind(store) as (id: string, channel: never) => Promise<never>;
	let crashed = false;
	return Object.assign(store, {
		async [method](id: string, channel: never) {
			const dies = !crashed && channel === "email";
			if (dies) crashed = true;
			if (dies && method === "markSent") throw new Error("worker died");
			const result = await real(id, channel);
			if (dies) throw new Error("worker died");
			return result;
		},
	});
}

function setup(
	overrides: {
		failEmailTimes?: number;
		allow?: Parameters<typeof createNotifier>[0]["allow"];
		delivery?: Parameters<typeof createNotifier>[0]["delivery"];
		crash?: "claimChannel" | "claimPending" | "markSent";
	} = {},
) {
	const memory = memoryNotificationStore();
	const store = overrides.crash ? crashOnce(memory, overrides.crash) : memory;
	const emails: { to: string; subject: string; idempotencyKey?: string }[] = [];
	const inApp: { userId: string; title: string; body?: string; idempotencyKey: string }[] = [];
	const texts: string[] = [];
	const pushes: string[][] = [];
	let failEmail = overrides.failEmailTimes ?? 0;
	// biome-ignore lint/suspicious/noExplicitAny: the consumers are wired in below
	let consumers: any[] = [];
	const driver = inlineDriver({ consumers: async () => consumers, logger, retryDelay: () => 0 });
	const jobs = createJobs({ driver });
	const notifier = createNotifier<NotificationsOf<typeof notifications>>({
		notifications,
		store,
		enqueue: jobs.enqueue as never,
		recipients: {
			async role(_org, role) {
				return role === "admin" ? ["u1", "u2"] : [];
			},
			async *permission(_org, permission) {
				if (permission === "invoice:read") yield* ["u2", "u3"];
			},
		},
		async contact(userId) {
			return {
				email: `${userId}@x`,
				phone: userId === "u3" ? null : "+100",
				language: userId === "u2" ? "ar" : "en",
			};
		},
		email: {
			async send(message, options) {
				if (failEmail-- > 0) throw new Error("smtp down");
				emails.push({
					to: message.to,
					subject: message.subject,
					...(options ? { idempotencyKey: options.idempotencyKey } : {}),
				});
			},
		},
		sms: { send: async (_to, text) => void texts.push(text) },
		push: {
			async send(tokens) {
				pushes.push([...tokens]);
				return { invalidTokens: tokens.filter((t) => t.startsWith("dead")) };
			},
		},
		...(overrides.allow ? { allow: overrides.allow } : {}),
		...(overrides.delivery ? { delivery: overrides.delivery } : {}),
		async onInApp(row) {
			inApp.push({
				userId: row.userId,
				title: row.title,
				...(row.body ? { body: row.body } : {}),
				idempotencyKey: row.idempotencyKey,
			});
		},
		translate,
		logger,
	});
	consumers = [...notifier.consumers];
	return { store, emails, texts, pushes, inApp, driver, notifier };
}

const data = { invoice: "INV-1", amount: 10 };

describe("notify", () => {
	it("stores an inbox entry and sends each channel to each recipient, in their language", async () => {
		const t = setup();
		await t.store.addPushToken("u1", "tok-1", "ios");
		await t.notifier.notify({
			orgId: "o1",
			to: { role: "admin" },
			notification: "billing.invoice-paid",
			data,
		});
		await t.driver.drain();
		expect(t.driver.dead).toEqual([]);
		expect(t.store.rows.map((r) => [r.userId, r.title])).toEqual([
			["u1", "Invoice INV-1 paid"],
			["u2", "تم دفع INV-1"],
		]);
		expect(t.emails.map((e) => e.to).sort()).toEqual(["u1@x", "u2@x"]);
		expect(t.texts).toHaveLength(2);
		expect(t.pushes).toEqual([["tok-1"]]);
	});

	it("fans out by permission and dedupes users", async () => {
		const t = setup();
		await t.notifier.notify({
			orgId: "o1",
			to: { permission: "invoice:read" },
			notification: "billing.invoice-paid",
			data,
			channels: ["in-app"],
		});
		await t.notifier.notify({
			orgId: "o1",
			to: { users: ["u4", "u4"] },
			notification: "billing.invoice-paid",
			data,
			channels: ["in-app"],
		});
		await t.driver.drain();
		expect(t.store.rows.map((r) => r.userId).sort()).toEqual(["u2", "u3", "u4"]);
		expect(t.emails).toEqual([]);
	});

	it("notifies once per recipient for the same idempotency key", async () => {
		const t = setup();
		for (let i = 0; i < 2; i++)
			await t.notifier.notify({
				orgId: "o1",
				to: { user: "u1" },
				notification: "billing.invoice-paid",
				data,
				idempotencyKey: "inv-1-paid",
			});
		await t.driver.drain();
		expect(t.store.rows).toHaveLength(1);
		expect(t.emails).toHaveLength(1);
	});

	it("sends a channel once when two deliveries of the same key run at once", async () => {
		const t = setup();
		const [, deliver] = t.notifier.consumers;
		const job = {
			orgId: "o1",
			userId: "u1",
			notification: "billing.invoice-paid",
			data,
			key: "k1",
			channels: ["email" as const],
		};
		await Promise.all([deliver.handle(job, { logger }), deliver.handle(job, { logger })]);
		expect(t.emails).toHaveLength(1);
	});

	it("retries only the channel that failed", async () => {
		const t = setup({ failEmailTimes: 1 });
		await t.notifier.notify({
			orgId: "o1",
			to: { user: "u1" },
			notification: "billing.invoice-paid",
			data,
		});
		await t.driver.drain();
		expect(t.emails).toHaveLength(1);
		expect(t.texts).toHaveLength(1);
		expect(t.store.rows).toHaveLength(1);
	});

	it("skips channels a user can't receive, and forgets dead push tokens", async () => {
		const t = setup();
		await t.store.addPushToken("u3", "dead-1", null);
		await t.notifier.notify({
			orgId: "o1",
			to: { user: "u3" },
			notification: "billing.invoice-paid",
			data,
		});
		await t.driver.drain();
		expect(t.texts).toEqual([]);
		expect(await t.store.pushTokens("u3")).toEqual([]);
		expect(t.store.rows[0]?.sent.sort()).toEqual(["email", "in-app", "push", "sms"]);
	});

	it("refuses data the notification's schema rejects, before queueing", async () => {
		const t = setup();
		await expect(
			t.notifier.notify({
				orgId: "o1",
				to: { user: "u1" },
				notification: "billing.invoice-paid",
				data: { invoice: 1 } as never,
			}),
		).rejects.toThrow(/Invalid data for notification billing.invoice-paid/);
	});

	it("needs a renderer for each channel it lists", () => {
		expect(() =>
			defineNotification({ name: "x", description: "", schema: z.object({}), channels: ["email"] }),
		).toThrow(/lists email but has no email\(\)/);
	});
});

describe("the app's own rules", () => {
	it("skips the channels the app says a user doesn't want", async () => {
		const asked: string[] = [];
		const t = setup({
			async allow({ userId, channel, notification }) {
				asked.push(`${userId}:${notification}:${channel}`);
				// u1 opted out of SMS; nobody gets push
				return !(channel === "push" || (userId === "u1" && channel === "sms"));
			},
		});
		await t.store.addPushToken("u1", "tok", null);
		await t.notifier.notify({
			orgId: "o1",
			to: { users: ["u1", "u2"] },
			notification: "billing.invoice-paid",
			data,
		});
		await t.driver.drain();
		expect(t.texts).toHaveLength(1);
		expect(t.pushes).toEqual([]);
		expect(t.emails).toHaveLength(2);
		expect(asked).toContain("u1:billing.invoice-paid:sms");
	});
});

describe("the consumers", () => {
	it("keep their literal topics, so an app's typed enqueue stays typed", () => {
		const { notifier } = setup();
		const topics: readonly ("notifications.fanout" | "notifications.deliver")[] =
			notifier.consumers.map((c) => c.topic);
		// @ts-expect-error: a literal topic is not any string
		const wide: "notifications.fanout" = notifier.consumers[1].topic;
		expect(topics).toEqual(["notifications.fanout", "notifications.deliver"]);
		expect(wide).toBe("notifications.deliver");
	});
});

describe("the inbox", () => {
	it("pages newest first and marks a user's own notifications read", async () => {
		const t = setup();
		await t.notifier.notify({
			orgId: "o1",
			to: { users: ["u1", "u2"] },
			notification: "billing.invoice-paid",
			data,
			channels: ["in-app"],
		});
		await t.driver.drain();
		const [mine] = await t.store.list("o1", "u1", { limit: 10 });
		const [theirs] = await t.store.list("o1", "u2", { limit: 10 });
		expect(await t.store.markRead("o1", "u1", [mine?.id as string, theirs?.id as string])).toBe(1);
		expect(await t.store.unreadCount("o1", "u1")).toBe(0);
		expect(await t.store.unreadCount("o1", "u2")).toBe(1);
	});
});

describe("senders", () => {
	it("sends SMS through Twilio's API", async () => {
		const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
		await twilioSms({
			accountSid: "AC1",
			authToken: "t",
			from: "+1555",
			fetch: fetch as never,
		}).send("+1666", "hi");
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
		expect(String(init.body)).toContain("To=%2B1666");
	});

	it("pushes through FCM with a signed service-account token, reporting unregistered devices", async () => {
		const { generateKeyPairSync } = await import("node:crypto");
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const calls: string[] = [];
		const fetch = vi.fn(async (url: string, init: RequestInit) => {
			calls.push(url);
			if (url.includes("oauth2")) {
				expect(String(init.body)).toContain("grant_type=urn");
				return Response.json({ access_token: "at", expires_in: 3600 });
			}
			const token = JSON.parse(String(init.body)).message.token;
			if (token === "down") throw new Error("ECONNRESET");
			return token === "gone"
				? new Response(
						'{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
						{ status: 404 },
					)
				: Response.json({ name: "ok" });
		});
		const push = fcmPush({
			projectId: "p1",
			clientEmail: "svc@p1.iam.gserviceaccount.com",
			privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
			fetch: fetch as never,
		});
		expect(await push.send(["ok-1", "gone"], { title: "Hi" })).toEqual({ invalidTokens: ["gone"] });
		// nothing reached a live device: the job retries, and still learns which token is gone
		await expect(push.send(["gone", "down"], { title: "Hi" })).rejects.toMatchObject({
			invalidTokens: ["gone"],
		});
		// the access token is reused while it's valid
		expect(calls.filter((u) => u.includes("oauth2"))).toHaveLength(1);
		await push.send(["ok-2"], {
			title: "Hi",
			body: "There",
			imageUrl: "https://img/x.png",
			link: "https://app/x",
			data: { id: "1" },
		});
		const last = fetch.mock.calls.at(-1) as unknown as [string, RequestInit];
		expect(JSON.parse(String(last[1].body))).toEqual({
			message: {
				token: "ok-2",
				notification: { title: "Hi", body: "There", image: "https://img/x.png" },
				data: { id: "1" },
				webpush: { fcm_options: { link: "https://app/x" } },
			},
		});
	});
});

describe("translated at read", () => {
	it("stores keys and params, and renders them in each reader's language", async () => {
		const t = setup();
		await t.notifier.notify({
			orgId: "o1",
			to: { users: ["u1", "u2"] },
			notification: "billing.invoice-due",
			data: { invoice: "INV-9" },
		});
		await t.driver.drain();
		expect(t.driver.dead).toEqual([]);
		const [row] = await t.store.list("o1", "u1", { limit: 10 });
		if (!row) throw new Error("no inbox entry");
		expect(row).toMatchObject({
			title: "",
			titleKey: "billing.due.title",
			bodyKey: "billing.due.body",
			params: { invoice: "INV-9" },
			url: "/invoices/INV-9",
		});
		// the same row, read by someone who switched language
		expect(localizeNotification(row, "en", translate)).toMatchObject({
			title: "Invoice INV-9 is due",
			body: "Pay INV-9 today",
		});
		expect(localizeNotification(row, "ar", translate)).toMatchObject({
			title: "الفاتورة INV-9 مستحقة",
			body: "ادفع INV-9 اليوم",
		});
		// without a translator the key shows, never an empty title
		expect(localizeNotification(row, "en").title).toBe("billing.due.title");
		// what's pushed live is in the recipient's own language
		expect(t.inApp.map((r) => [r.userId, r.title])).toEqual([
			["u1", "Invoice INV-9 is due"],
			["u2", "الفاتورة INV-9 مستحقة"],
		]);
	});

	it("leaves text notifications as they were stored", async () => {
		const t = setup();
		await t.notifier.notify({
			orgId: "o1",
			to: { user: "u2" },
			notification: "billing.invoice-paid",
			data,
			channels: ["in-app"],
		});
		await t.driver.drain();
		const [row] = await t.store.list("o1", "u2", { limit: 10 });
		if (!row) throw new Error("no inbox entry");
		expect(row).toMatchObject({
			title: "تم دفع INV-1",
			titleKey: null,
			bodyKey: null,
			params: null,
		});
		expect(localizeNotification(row, "en", translate)).toBe(row);
		expect(t.inApp.map((r) => r.title)).toEqual(["تم دفع INV-1"]);
	});
});

describe("delivery modes", () => {
	const once = {
		orgId: "o1",
		to: { user: "u1" },
		notification: "billing.invoice-paid",
		data,
	} as const;

	it("at-least-once: a crash after the claim sends it on the retry", async () => {
		const t = setup({ delivery: { email: "at-least-once" }, crash: "claimPending" });
		await t.notifier.notify({ ...once, channels: ["email", "sms"] });
		await t.driver.drain();
		expect(t.driver.dead).toEqual([]);
		expect(t.emails).toHaveLength(1);
		expect(t.texts).toHaveLength(1);
		const [row] = t.store.rows;
		expect(t.emails[0]?.idempotencyKey).toBe(`${row?.id}:email:u1`);
		expect(row?.delivered).toEqual(["email"]);
	});

	it("at-least-once: a crash after sending resends once, with the same idempotency key", async () => {
		const t = setup({ delivery: { email: "at-least-once" }, crash: "markSent" });
		await t.notifier.notify({ ...once, channels: ["email"] });
		await t.driver.drain();
		expect(t.emails).toHaveLength(2);
		expect(new Set(t.emails.map((e) => e.idempotencyKey)).size).toBe(1);
		// sent now: another delivery of the job sends nothing
		const [, deliver] = t.notifier.consumers;
		await deliver.handle(
			{ ...once, userId: "u1", key: t.store.rows[0]?.key as string, channels: ["email"] },
			{ logger },
		);
		expect(t.emails).toHaveLength(2);
	});

	it("at-most-once by default: a crash after the claim never sends it", async () => {
		const t = setup({ crash: "claimChannel" });
		await t.notifier.notify({ ...once, channels: ["email", "sms"] });
		await t.driver.drain();
		expect(t.emails).toEqual([]);
		expect(t.texts).toHaveLength(1);
	});

	it("needs a store that can record pending channels", () => {
		const { claimPending: _c, markSent: _m, ...store } = memoryNotificationStore();
		expect(() =>
			createNotifier({
				notifications,
				store,
				enqueue: async () => "",
				recipients: { role: async () => [], permission: async () => [] },
				contact: async () => null,
				delivery: { email: "at-least-once" },
				logger,
			}),
		).toThrow(/needs a store with claimPending\(\) and markSent\(\)/);
	});
});
