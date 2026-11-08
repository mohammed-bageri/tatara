import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createEmailQueue,
	createSuppressionList,
	createUnsubscribeTokens,
	defineEmail,
	definitionRenderer,
	type EmailMessage,
	type EmailQueueOptions,
	memoryEmailQueueStore,
	memorySuppressionStore,
} from "./index.ts";

const logger = pino({ level: "silent" });

function setup(overrides: Partial<EmailQueueOptions> = {}) {
	const store = memoryEmailQueueStore();
	const suppressionStore = memorySuppressionStore();
	const suppressions = createSuppressionList(suppressionStore);
	const sent: EmailMessage[] = [];
	const mailer = {
		send: vi.fn(async (m: EmailMessage): Promise<{ id: string | null }> => {
			sent.push(m);
			return { id: `<msg-${sent.length}@mg>` };
		}),
	};
	let clock = new Date("2026-01-01T10:00:00Z");
	const queue = createEmailQueue({
		store,
		mailer,
		suppressions,
		render: (job, { unsubscribeUrl }) =>
			job.templateKey === "missing"
				? null
				: {
						subject: `Hi ${String(job.variables.name)}`,
						html: `<p>${job.language}</p>${unsubscribeUrl ? `<a>${unsubscribeUrl}</a>` : ""}`,
						text: "Hello",
					},
		logger,
		now: () => clock,
		...overrides,
	});
	return {
		store,
		suppressions,
		suppressionStore,
		mailer,
		sent,
		queue,
		advance: (ms: number) => {
			clock = new Date(clock.getTime() + ms);
		},
	};
}

const input = (extra: Record<string, unknown> = {}) => ({
	orgId: "org-1",
	templateKey: "welcome",
	recipient: "ada@example.com",
	variables: { name: "Ada" },
	idempotencyKey: "welcome:ada",
	...extra,
});

describe("the email queue", () => {
	it("queues once per idempotency key", async () => {
		const { queue, store } = setup();
		const first = await queue.enqueue(input());
		expect(first.status).toBe("created");
		expect(await queue.enqueue(input())).toEqual({ status: "exists" });
		expect(store.jobs.size).toBe(1);
	});

	it("sends due jobs with the job id variable, logs them and marks them sent", async () => {
		const { queue, store, sent } = setup({ jobIdVariable: "sana_job_id" });
		const r = await queue.enqueue(input({ language: "ar", replyTo: "hr@example.com" }));
		const jobId = r.status === "created" ? r.jobId : "";
		expect(await queue.process()).toEqual({ processed: 1, failed: 0 });
		expect(sent[0]).toMatchObject({
			to: "ada@example.com",
			subject: "Hi Ada",
			html: "<p>ar</p>",
			text: "Hello",
			replyTo: "hr@example.com",
			variables: { sana_job_id: jobId },
		});
		expect(store.jobs.get(jobId)).toMatchObject({ status: "sent", attempts: 1 });
		expect(store.sendLog[0]).toMatchObject({
			jobId,
			status: "sent",
			providerMessageId: "<msg-1@mg>",
			subject: "Hi Ada",
		});
		expect(await queue.status("welcome:ada")).toEqual({
			status: "sent",
			attempts: 1,
			lastError: null,
		});
	});

	it("waits for scheduledFor and uses the subject override", async () => {
		const { queue, sent, advance } = setup();
		await queue.enqueue(
			input({ scheduledFor: new Date("2026-01-01T11:00:00Z"), subjectOverride: "Reminder" }),
		);
		expect((await queue.process()).processed).toBe(0);
		advance(60 * 60 * 1000);
		await queue.process();
		expect(sent[0]?.subject).toBe("Reminder");
	});

	it("retries with backoff, then fails for good and logs the failure", async () => {
		const { queue, store, mailer, advance } = setup({ maxAttempts: 2, backoffMs: [1000] });
		mailer.send.mockRejectedValue(new Error("Mailgun answered 500"));
		await queue.enqueue(input());
		expect(await queue.process()).toEqual({ processed: 0, failed: 1 });
		const [job] = [...store.jobs.values()];
		expect(job).toMatchObject({
			status: "pending",
			attempts: 1,
			lastError: "Mailgun answered 500",
		});
		expect((await queue.process()).failed).toBe(0); // not due yet
		advance(1000);
		await queue.process();
		expect([...store.jobs.values()][0]).toMatchObject({ status: "failed", attempts: 2 });
		expect(store.sendLog).toMatchObject([
			{ status: "failed", errorMessage: "Mailgun answered 500" },
		]);
	});

	it("fails a job whose template is unknown", async () => {
		const { queue, store } = setup({ maxAttempts: 1 });
		await queue.enqueue(input({ templateKey: "missing" }));
		await queue.process();
		expect([...store.jobs.values()][0]).toMatchObject({
			status: "failed",
			lastError: "Template not found: missing",
		});
	});

	it("cancels a job whose recipient is suppressed, without sending", async () => {
		const { queue, store, suppressions, mailer } = setup();
		await queue.enqueue(input());
		await suppressions.suppress({ orgId: "org-1", address: "ADA@example.com ", reason: "bounced" });
		await queue.process();
		expect(mailer.send).not.toHaveBeenCalled();
		expect([...store.jobs.values()][0]).toMatchObject({
			status: "cancelled",
			lastError: "suppressed: bounced",
		});
	});

	it("adds the unsubscribe link, its text and the one-click headers", async () => {
		const tokens = createUnsubscribeTokens({ secret: "s3cret" });
		const { queue, sent } = setup({
			unsubscribe: {
				tokens,
				urls: async (job, token) => ({
					page: `https://app/unsubscribe/${token}?lang=${job.language}`,
					oneClick: `https://api/email/unsubscribe/${token}`,
				}),
			},
		});
		const r = await queue.enqueue(input({ unsubscribeLink: true, language: "ar" }));
		await queue.process();
		const token = tokens.sign(r.status === "created" ? r.jobId : "");
		expect(sent[0]?.html).toContain(`https://app/unsubscribe/${token}?lang=ar`);
		expect(sent[0]?.text).toBe(`Hello\n\nإلغاء الاشتراك: https://app/unsubscribe/${token}?lang=ar`);
		expect(sent[0]?.headers).toEqual({
			"List-Unsubscribe": `<https://api/email/unsubscribe/${token}>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		});
	});

	it("refuses an unsubscribe link without the unsubscribe option", async () => {
		const { queue } = setup();
		await expect(queue.enqueue(input({ unsubscribeLink: true }))).rejects.toThrow(/unsubscribe/);
	});

	it("holds, releases, drops and discards", async () => {
		const { queue, store, sent } = setup();
		const a = await queue.hold(input({ idempotencyKey: "a" }));
		const b = await queue.hold(input({ idempotencyKey: "b" }));
		const c = await queue.hold(
			input({ idempotencyKey: "c", entityType: "session", entityId: "s1" }),
		);
		const id = (r: typeof a) => (r.status === "created" ? r.jobId : "");
		await queue.process();
		expect(sent).toHaveLength(0);
		expect(await queue.release([id(a)])).toBe(1);
		expect(await queue.drop([id(b)])).toBe(1);
		expect(await queue.discard({ entityType: "session", entityId: "s1" })).toBe(1);
		await queue.process();
		expect(sent).toHaveLength(1);
		expect(store.jobs.get(id(b))?.status).toBe("cancelled");
		expect(store.jobs.has(id(c))).toBe(false);
		// discarded: the key is free again
		expect((await queue.hold(input({ idempotencyKey: "c" }))).status).toBe("created");
		expect(await queue.release([])).toBe(0);
	});

	it("cancels unsent emails by key or entity, never sent ones", async () => {
		const { queue, store } = setup();
		await queue.enqueue(input({ idempotencyKey: "k1", entityType: "offer", entityId: "o1" }));
		await queue.hold(input({ idempotencyKey: "k2", entityType: "offer", entityId: "o1" }));
		await queue.enqueue(input({ idempotencyKey: "k3" }));
		expect(await queue.cancel({ entityType: "offer", entityId: "o1" })).toBe(2);
		await queue.process();
		expect(await queue.cancel({ idempotencyKey: "k3" })).toBe(0);
		expect([...store.jobs.values()].map((j) => j.status).sort()).toEqual([
			"cancelled",
			"cancelled",
			"sent",
		]);
	});

	it("skips a process call while one is running", async () => {
		const { queue, mailer } = setup();
		let finish!: () => void;
		mailer.send.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = () => resolve({ id: null });
				}),
		);
		await queue.enqueue(input());
		const first = queue.process();
		await vi.waitFor(() => expect(finish).toBeDefined());
		expect(await queue.process()).toEqual({ processed: 0, failed: 0, skipped: true });
		finish();
		expect(await first).toEqual({ processed: 1, failed: 0 });
	});
});

describe("leases", () => {
	const MIN = 60_000;
	const store = () => memoryEmailQueueStore();
	type Store = ReturnType<typeof store>;
	// one worker process; `dies` makes its send hang forever, like a process killed mid-send
	function worker(s: Store, at: string, opts: { dies?: boolean; maxAttempts?: number } = {}) {
		const send = vi.fn(
			(): Promise<{ id: string | null }> =>
				opts.dies ? new Promise(() => {}) : Promise.resolve({ id: "<ok>" }),
		);
		const queue = createEmailQueue({
			store: s,
			mailer: { send },
			render: () => ({ subject: "s", text: "t" }),
			leaseMs: 5 * MIN,
			...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
			logger,
			now: () => new Date(at),
		});
		return { queue, send };
	}
	async function dieMidSend(s: Store, at: string) {
		const w = worker(s, at, { dies: true });
		void w.queue.process();
		await vi.waitFor(() => expect(w.send).toHaveBeenCalledTimes(1));
	}

	it("reclaims a job whose worker died once the lease is over, counting the attempt", async () => {
		const s = store();
		await worker(s, "2026-01-01T10:00:00Z").queue.enqueue(input());
		await dieMidSend(s, "2026-01-01T10:00:00Z");
		const [job] = [...s.jobs.values()];
		expect(job).toMatchObject({ status: "processing", attempts: 0 });
		expect(job?.claimedUntil?.toISOString()).toBe("2026-01-01T10:05:00.000Z");

		const early = worker(s, "2026-01-01T10:04:59Z");
		expect(await early.queue.process()).toEqual({ processed: 0, failed: 0 });
		expect(early.send).not.toHaveBeenCalled();

		const late = worker(s, "2026-01-01T10:05:01Z");
		expect(await late.queue.process()).toEqual({ processed: 1, failed: 0 });
		expect(late.send).toHaveBeenCalledTimes(1);
		expect(s.jobs.get(job!.id)).toMatchObject({ status: "sent", attempts: 2, claimedUntil: null });
	});

	it("fails a job for good after maxAttempts crashes, without sending it again", async () => {
		const s = store();
		await worker(s, "2026-01-01T10:00:00Z", { maxAttempts: 3 }).queue.enqueue(input());
		await dieMidSend(s, "2026-01-01T10:00:00Z");
		await dieMidSend(s, "2026-01-01T10:06:00Z");
		await dieMidSend(s, "2026-01-01T10:12:00Z");
		const last = worker(s, "2026-01-01T10:18:00Z");
		expect(await last.queue.process()).toEqual({ processed: 0, failed: 1 });
		expect(last.send).not.toHaveBeenCalled();
		expect([...s.jobs.values()][0]).toMatchObject({
			status: "failed",
			attempts: 3,
			claimedUntil: null,
		});
		expect(s.sendLog).toMatchObject([
			{ status: "failed", errorMessage: expect.stringMatching(/lease expired/) },
		]);
		expect(await last.queue.process()).toEqual({ processed: 0, failed: 0 });
	});

	it("refuses a lease that isn't positive", () => {
		expect(() => setup({ leaseMs: 0 })).toThrow(/leaseMs/);
	});
});

describe("definitionRenderer", () => {
	const welcome = defineEmail({
		name: "users.welcome",
		schema: z.object({ name: z.string() }),
		render: ({ name }) => ({ subject: "Welcome", text: `Hi ${name}`, html: `<p>Hi ${name}</p>` }),
	});

	it("renders the job's template through the layout, null for an unknown one", async () => {
		const render = definitionRenderer([welcome], { layout: (html) => `<main>${html}</main>` });
		const { queue, sent } = setup({ render });
		await queue.enqueue(input({ templateKey: "users.welcome" }));
		await queue.process();
		expect(sent[0]).toMatchObject({ subject: "Welcome", html: "<main><p>Hi Ada</p></main>" });
		const job = { templateKey: "other", variables: {}, language: "en" };
		expect(await render(job as never, {})).toBeNull();
	});
});
