/**
 * A durable send queue over the app's tables: enqueue with an idempotency key (now, later, or
 * held), then a schedule drains it with retries and backoff, consulting the suppression list and
 * adding unsubscribe links. Every send and final failure goes in the send log.
 */
import type { CoreLogger } from "@tatara/core";
import { layoutLabels } from "./layout.ts";
import type { Mailer } from "./mailer.ts";
import { hashVariables } from "./placeholders.ts";
import type { SuppressionList } from "./suppression.ts";
import { type EmailDefinition, renderEmail } from "./templates.ts";
import { type UnsubscribeTokens, unsubscribeHeaders } from "./unsubscribe.ts";

export type EmailJobStatus = "pending" | "held" | "processing" | "sent" | "failed" | "cancelled";

export interface EmailJob {
	id: string;
	orgId: string;
	templateKey: string;
	recipient: string;
	variables: Record<string, unknown>;
	idempotencyKey: string;
	subjectOverride: string | null;
	status: EmailJobStatus;
	attempts: number;
	maxAttempts: number;
	scheduledFor: Date;
	nextAttemptAt: Date;
	lastError: string | null;
	/** what the email is about (e.g. "session", id), so its unsent emails can be cancelled together */
	entityType: string | null;
	entityId: string | null;
	language: string;
	replyTo: string | null;
	/** add a signed unsubscribe link and the one-click headers when it's sent */
	unsubscribeLink: boolean;
	createdAt: Date;
	updatedAt: Date;
	processedAt: Date | null;
}

export type NewEmailJob = Omit<EmailJob, "id">;

export type EmailJobPatch = Partial<
	Pick<
		EmailJob,
		"status" | "attempts" | "lastError" | "nextAttemptAt" | "scheduledFor" | "processedAt"
	>
> & { updatedAt: Date };

export type EmailJobFilter =
	| { ids: readonly string[] }
	| { idempotencyKey: string }
	| { entityType: string; entityId: string };

export interface EmailLogEntry {
	orgId: string;
	jobId: string | null;
	templateKey: string;
	recipient: string;
	subject: string;
	status: "sent" | "failed";
	/** the provider's message id, as the mailer returned it (`<…>` for Mailgun and SMTP) */
	providerMessageId: string | null;
	variablesHash: string;
	errorMessage: string | null;
	sentAt: Date;
}

/** The org, job and address a sent message went to. */
export interface SentMessageRef {
	orgId: string;
	jobId: string | null;
	recipient: string;
}

/** The app's send-jobs and send-log tables. `executor` is the caller's transaction, when given. */
export interface EmailQueueStore {
	/** inserts unless a job has the idempotency key: its id, or null when one already does */
	insert(job: NewEmailJob, executor?: unknown): Promise<string | null>;
	/**
	 * Atomically moves up to `limit` pending jobs due by `now` (scheduledFor and nextAttemptAt)
	 * to "processing" and returns them; two workers never get the same job (SKIP LOCKED).
	 */
	claimDue(now: Date, limit: number): Promise<EmailJob[]>;
	update(id: string, patch: EmailJobPatch): Promise<void>;
	/** patches the matching jobs whose status is in `from`; how many */
	updateWhere(
		filter: EmailJobFilter,
		from: readonly EmailJobStatus[],
		patch: EmailJobPatch,
		executor?: unknown,
	): Promise<number>;
	/** deletes the matching jobs whose status is in `from`; how many */
	deleteWhere(
		filter: EmailJobFilter,
		from: readonly EmailJobStatus[],
		executor?: unknown,
	): Promise<number>;
	/** null for an unknown id, malformed ones included (never throws for those) */
	get(id: string): Promise<EmailJob | null>;
	findByIdempotencyKey(key: string): Promise<EmailJob | null>;
	log(entry: EmailLogEntry): Promise<void>;
	/** the logged send with that provider message id */
	findSent(providerMessageId: string): Promise<SentMessageRef | null>;
}

export interface QueueEmailInput {
	orgId: string;
	templateKey: string;
	recipient: string;
	variables?: Record<string, unknown>;
	/** the same key queues the email once, however often this runs */
	idempotencyKey: string;
	entityType?: string;
	entityId?: string;
	/** not before then; default now */
	scheduledFor?: Date;
	subjectOverride?: string;
	language?: string;
	replyTo?: string;
	unsubscribeLink?: boolean;
	maxAttempts?: number;
	executor?: unknown;
}

export type QueueEmailResult = { status: "created"; jobId: string } | { status: "exists" };

export interface QueuedContent {
	subject: string;
	html?: string;
	text?: string;
}

export interface EmailQueueOptions {
	store: EmailQueueStore;
	mailer: Mailer;
	/**
	 * The job's subject and body, layout included; null when the template is unknown (the job
	 * fails and retries). `unsubscribeUrl` is set for jobs with `unsubscribeLink`.
	 */
	render(
		job: EmailJob,
		context: { unsubscribeUrl?: string },
	): Promise<QueuedContent | null> | QueuedContent | null;
	/** checked before each send: a suppressed recipient's job is cancelled */
	suppressions?: SuppressionList;
	/** needed by jobs with `unsubscribeLink` */
	unsubscribe?: {
		tokens: UnsubscribeTokens;
		/** the page a person opens, and the URL mail clients POST to (RFC 8058) */
		urls(job: EmailJob, token: string): Promise<{ page: string; oneClick: string }>;
		/** the text part's link label; default "Unsubscribe" (English, Arabic) */
		label?(language: string): string;
	};
	/** the provider variable carrying the job id, read back by the webhook; default "tatara_job_id" */
	jobIdVariable?: string;
	/** delays before each retry; the last repeats (default 1m, 5m, 15m, 1h, 4h) */
	backoffMs?: readonly number[];
	/** default 5 */
	maxAttempts?: number;
	/** default "en" */
	defaultLanguage?: string;
	logger: CoreLogger;
	now?: () => Date;
}

export interface ProcessResult {
	processed: number;
	failed: number;
	/** another `process` call in this process was still running */
	skipped?: true;
}

const MINUTE = 60_000;
const DEFAULT_BACKOFF = [MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE, 240 * MINUTE];
const UNSENT: readonly EmailJobStatus[] = ["pending", "held"];
const HELD: readonly EmailJobStatus[] = ["held"];

export const DEFAULT_JOB_ID_VARIABLE = "tatara_job_id";

export function createEmailQueue(options: EmailQueueOptions) {
	const { store, logger } = options;
	const now = options.now ?? (() => new Date());
	const backoff = options.backoffMs?.length ? options.backoffMs : DEFAULT_BACKOFF;
	const jobIdVariable = options.jobIdVariable ?? DEFAULT_JOB_ID_VARIABLE;
	let running = false;

	async function insert(input: QueueEmailInput, status: "pending" | "held") {
		if (input.unsubscribeLink && !options.unsubscribe)
			throw new Error("unsubscribeLink needs the queue's `unsubscribe` option");
		const at = now();
		const when = input.scheduledFor ?? at;
		const id = await store.insert(
			{
				orgId: input.orgId,
				templateKey: input.templateKey,
				recipient: input.recipient,
				variables: input.variables ?? {},
				idempotencyKey: input.idempotencyKey,
				subjectOverride: input.subjectOverride ?? null,
				status,
				attempts: 0,
				maxAttempts: input.maxAttempts ?? options.maxAttempts ?? 5,
				scheduledFor: when,
				nextAttemptAt: when,
				lastError: null,
				entityType: input.entityType ?? null,
				entityId: input.entityId ?? null,
				language: input.language ?? options.defaultLanguage ?? "en",
				replyTo: input.replyTo ?? null,
				unsubscribeLink: input.unsubscribeLink ?? false,
				createdAt: at,
				updatedAt: at,
				processedAt: null,
			},
			input.executor,
		);
		if (!id) return { status: "exists" } as const;
		logger.info({ jobId: id, templateKey: input.templateKey }, "email queued");
		return { status: "created", jobId: id } as const;
	}

	async function send(job: EmailJob): Promise<void> {
		const at = now();
		try {
			const reason = await options.suppressions?.reason(job.orgId, job.recipient);
			if (reason) {
				await store.update(job.id, {
					status: "cancelled",
					lastError: `suppressed: ${reason}`,
					processedAt: at,
					updatedAt: at,
				});
				return;
			}
			let unsubscribeUrl: string | undefined;
			let headers: Record<string, string> | undefined;
			if (job.unsubscribeLink && options.unsubscribe) {
				const token = options.unsubscribe.tokens.sign(job.id);
				const urls = await options.unsubscribe.urls(job, token);
				unsubscribeUrl = urls.page;
				headers = unsubscribeHeaders(urls.oneClick);
			}
			const content = await options.render(job, unsubscribeUrl ? { unsubscribeUrl } : {});
			if (!content) throw new Error(`Template not found: ${job.templateKey}`);
			if (!content.html && !content.text)
				throw new Error(`Template ${job.templateKey} rendered no html or text`);
			const subject = job.subjectOverride || content.subject;
			const label =
				options.unsubscribe?.label?.(job.language) ?? layoutLabels(job.language).unsubscribe;
			const text =
				content.text && unsubscribeUrl
					? `${content.text}\n\n${label}: ${unsubscribeUrl}`
					: content.text;
			const sent = await options.mailer.send({
				to: job.recipient,
				subject,
				...(content.html ? { html: content.html } : {}),
				...(text ? { text } : {}),
				...(job.replyTo ? { replyTo: job.replyTo } : {}),
				...(headers ? { headers } : {}),
				variables: { [jobIdVariable]: job.id },
			});
			await store.update(job.id, {
				status: "sent",
				attempts: job.attempts + 1,
				processedAt: at,
				updatedAt: at,
			});
			await store.log({
				orgId: job.orgId,
				jobId: job.id,
				templateKey: job.templateKey,
				recipient: job.recipient,
				subject,
				status: "sent",
				providerMessageId: sent.id,
				variablesHash: hashVariables(job.variables),
				errorMessage: null,
				sentAt: at,
			});
			logger.info({ jobId: job.id, templateKey: job.templateKey }, "email sent");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const attempts = job.attempts + 1;
			if (attempts >= job.maxAttempts) {
				await store.update(job.id, {
					status: "failed",
					lastError: message,
					attempts,
					updatedAt: at,
				});
				await store.log({
					orgId: job.orgId,
					jobId: job.id,
					templateKey: job.templateKey,
					recipient: job.recipient,
					subject: job.subjectOverride || job.templateKey,
					status: "failed",
					providerMessageId: null,
					variablesHash: hashVariables(job.variables),
					errorMessage: message,
					sentAt: at,
				});
				logger.error({ jobId: job.id, attempts, err: message }, "email failed for good");
			} else {
				const delay = backoff[Math.min(attempts - 1, backoff.length - 1)]!;
				await store.update(job.id, {
					status: "pending",
					lastError: message,
					attempts,
					nextAttemptAt: new Date(at.getTime() + delay),
					updatedAt: at,
				});
				logger.warn({ jobId: job.id, attempts, err: message }, "email failed, will retry");
			}
			throw error;
		}
	}

	return {
		/** queues the email; `{ status: "exists" }` when the idempotency key was queued before */
		enqueue: (input: QueueEmailInput) => insert(input, "pending"),
		/** queues it held: not sent until `release`; `drop` or `discard` ends it unsent */
		hold: (input: QueueEmailInput) => insert(input, "held"),
		/** sends held emails now; how many */
		async release(ids: readonly string[]): Promise<number> {
			if (!ids.length) return 0;
			const at = now();
			return store.updateWhere({ ids }, HELD, {
				status: "pending",
				scheduledFor: at,
				nextAttemptAt: at,
				updatedAt: at,
			});
		},
		/** cancels held emails (kept as the trace); how many */
		async drop(ids: readonly string[]): Promise<number> {
			if (!ids.length) return 0;
			return store.updateWhere({ ids }, HELD, { status: "cancelled", updatedAt: now() });
		},
		/** deletes held emails, freeing their idempotency keys; how many */
		async discard(
			filter: { ids: readonly string[] } | { entityType: string; entityId: string },
			executor?: unknown,
		): Promise<number> {
			if ("ids" in filter && !filter.ids.length) return 0;
			return store.deleteWhere(filter, HELD, executor);
		},
		/** cancels pending or held emails; how many */
		async cancel(filter: EmailJobFilter): Promise<number> {
			if ("ids" in filter && !filter.ids.length) return 0;
			return store.updateWhere(filter, UNSENT, { status: "cancelled", updatedAt: now() });
		},
		async status(idempotencyKey: string) {
			const job = await store.findByIdempotencyKey(idempotencyKey);
			return job ? { status: job.status, attempts: job.attempts, lastError: job.lastError } : null;
		},
		/** sends what is due; run it from a schedule. A call while one runs here is skipped. */
		async process(input: { limit?: number } = {}): Promise<ProcessResult> {
			if (running) return { processed: 0, failed: 0, skipped: true };
			running = true;
			try {
				const jobs = await store.claimDue(now(), input.limit ?? 50);
				let processed = 0;
				let failed = 0;
				for (const job of jobs) {
					try {
						await send(job);
						processed++;
					} catch {
						failed++;
					}
				}
				return { processed, failed };
			} finally {
				running = false;
			}
		},
	};
}

export type EmailQueue = ReturnType<typeof createEmailQueue>;

/** A `render` for `defineEmail` templates: the job's template key is the email's name. */
export function definitionRenderer(
	// biome-ignore lint/suspicious/noExplicitAny: any template, whatever its data
	definitions: readonly EmailDefinition<string, any>[],
	options: { layout?(html: string, job: EmailJob, unsubscribeUrl?: string): string } = {},
): EmailQueueOptions["render"] {
	const byName = new Map(definitions.map((d) => [d.name, d]));
	return (job, { unsubscribeUrl }) => {
		const definition = byName.get(job.templateKey);
		if (!definition) return null;
		const rendered = renderEmail(definition, job.variables, job.language);
		const html =
			rendered.html && options.layout
				? options.layout(rendered.html, job, unsubscribeUrl)
				: rendered.html;
		return { subject: rendered.subject, text: rendered.text, ...(html ? { html } : {}) };
	};
}
