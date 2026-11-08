/** Mailgun delivery webhooks: signature check, replay guard, hard failures into the suppression list. */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CoreLogger } from "@tatara/core";
import { z } from "zod";
import { DEFAULT_JOB_ID_VARIABLE, type EmailQueueStore, type SentMessageRef } from "./queue.ts";
import type { SuppressionList, SuppressionReason } from "./suppression.ts";

/** Mailgun signs each delivery with a fresh token; older or reused ones are refused. */
export const MAILGUN_SIGNATURE_TOLERANCE_SECONDS = 15 * 60;

export const mailgunWebhookBody = z.object({
	signature: z.object({
		timestamp: z.string().regex(/^\d{1,12}$/),
		token: z.string().min(1).max(200),
		signature: z.string().regex(/^[0-9a-f]{64}$/i),
	}),
	"event-data": z.object({
		event: z.string().optional(),
		severity: z.string().optional(),
		recipient: z.string().optional(),
		"user-variables": z.record(z.string(), z.unknown()).optional(),
		message: z
			.object({ headers: z.object({ "message-id": z.string().optional() }).partial() })
			.partial()
			.optional(),
	}),
});
export type MailgunWebhookBody = z.infer<typeof mailgunWebhookBody>;
export type MailgunEventData = MailgunWebhookBody["event-data"];

export function verifyMailgunSignature(
	signingKey: string,
	sig: MailgunWebhookBody["signature"],
	now: Date = new Date(),
): boolean {
	const age = Math.abs(now.getTime() / 1000 - Number(sig.timestamp));
	if (age > MAILGUN_SIGNATURE_TOLERANCE_SECONDS) return false;
	const expected = createHmac("sha256", signingKey)
		.update(sig.timestamp + sig.token)
		.digest();
	const given = Buffer.from(sig.signature, "hex");
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A permanent failure is a bounce; temporary failures, deliveries, opens… suppress nothing. */
export function mailgunSuppressionReason(data: MailgunEventData): SuppressionReason | null {
	if (data.event === "failed") return data.severity === "permanent" ? "bounced" : null;
	if (data.event === "complained") return "complained";
	if (data.event === "unsubscribed") return "unsubscribed";
	return null;
}

/** Where seen signing tokens are kept for the tolerance window; `@tatara/cache` fits. */
export interface ReplayGuard {
	/** true when the key was not there and is now */
	add(key: string, value: unknown, options: { ttlMs: number }): Promise<boolean>;
	del(...keys: string[]): Promise<void>;
}

export type MailgunWebhookResult =
	| { status: 200; outcome: "suppressed" | "ignored" }
	/** unsigned, stale or replayed; Mailgun does not retry a 406 */
	| { status: 406; reason: "invalid" | "replayed" }
	/** no signing key configured */
	| { status: 404 };

export interface MailgunWebhookOptions {
	/** the webhook signing key; unset answers 404 */
	signingKey: string | undefined;
	store: Pick<EmailQueueStore, "get" | "findSent">;
	suppressions: SuppressionList;
	replay: ReplayGuard;
	/** the variable the queue sent the job id in; default "tatara_job_id" */
	jobIdVariable?: string;
	logger: CoreLogger;
	now?: () => Date;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** `handle(await c.req.json())`, then answer with its status. Throws (and frees the token) on a failed write. */
export function createMailgunWebhook(options: MailgunWebhookOptions) {
	const { logger } = options;
	const jobIdVariable = options.jobIdVariable ?? DEFAULT_JOB_ID_VARIABLE;
	const tokenKey = (token: string) => `email:mailgun-webhook:${token}`;

	async function sentMessageOf(data: MailgunEventData): Promise<SentMessageRef | null> {
		const jobId = data["user-variables"]?.[jobIdVariable];
		if (typeof jobId === "string" && jobId) {
			const job = await options.store.get(jobId);
			return job ? { orgId: job.orgId, jobId: job.id, recipient: job.recipient } : null;
		}
		const messageId = data.message?.headers?.["message-id"];
		return messageId ? options.store.findSent(`<${messageId}>`) : null;
	}

	/** Records a hard bounce, complaint or unsubscribe; anything else, or an unknown message, is ignored. */
	async function handleEvent(data: MailgunEventData): Promise<"suppressed" | "ignored"> {
		const reason = mailgunSuppressionReason(data);
		if (!reason || !data.recipient) return "ignored";
		const sent = await sentMessageOf(data);
		if (!sent) {
			logger.info({ event: data.event }, "Mailgun event for an unknown message; ignored");
			return "ignored";
		}
		if (!same(sent.recipient, data.recipient)) {
			logger.warn(
				{ event: data.event, jobId: sent.jobId },
				"Mailgun event recipient differs from the sent message; ignored",
			);
			return "ignored";
		}
		await options.suppressions.suppress({
			orgId: sent.orgId,
			address: sent.recipient,
			reason,
			sourceJobId: sent.jobId,
		});
		logger.info({ orgId: sent.orgId, jobId: sent.jobId, reason }, "address suppressed by Mailgun");
		return "suppressed";
	}

	return {
		handleEvent,
		async handle(body: unknown): Promise<MailgunWebhookResult> {
			if (!options.signingKey) {
				logger.warn("Mailgun webhook called without a signing key");
				return { status: 404 };
			}
			const parsed = mailgunWebhookBody.safeParse(body);
			const now = options.now?.() ?? new Date();
			if (
				!parsed.success ||
				!verifyMailgunSignature(options.signingKey, parsed.data.signature, now)
			) {
				logger.warn("Mailgun webhook refused: bad or stale signature");
				return { status: 406, reason: "invalid" };
			}
			const { token } = parsed.data.signature;
			const ttlMs = MAILGUN_SIGNATURE_TOLERANCE_SECONDS * 1000;
			if (!(await options.replay.add(tokenKey(token), 1, { ttlMs }))) {
				logger.warn("Mailgun webhook refused: replayed token");
				return { status: 406, reason: "replayed" };
			}
			try {
				return { status: 200, outcome: await handleEvent(parsed.data["event-data"]) };
			} catch (error) {
				// so Mailgun's retry of this event is accepted
				await options.replay.del(tokenKey(token));
				throw error;
			}
		},
	};
}
