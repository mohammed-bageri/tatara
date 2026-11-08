/** Signed, non-expiring unsubscribe tokens (`<id>.<base64url HMAC>`) and RFC 8058 headers. */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { EmailJob, EmailQueueStore } from "./queue.ts";
import type { SuppressionList } from "./suppression.ts";

const CONTEXT = "unsubscribe:v1:";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface UnsubscribeTokens {
	/** a token for the queued email `id` (no address in it) */
	sign(id: string): string;
	/** the id the token was signed for, or null for anything else */
	verify(token: string): string | null;
}

export interface UnsubscribeTokenOptions {
	/** the app's long-lived secret; the signing key is derived from it with HKDF-SHA256 */
	secret: string;
	/** HKDF info; change it and every token already sent stops working */
	info?: string;
}

export function createUnsubscribeTokens(options: UnsubscribeTokenOptions): UnsubscribeTokens {
	if (!options.secret) throw new Error("Unsubscribe tokens need a secret");
	const key = Buffer.from(
		hkdfSync("sha256", options.secret, "", options.info ?? "tatara-email-unsubscribe-v1", 32),
	);
	const signature = (id: string) =>
		createHmac("sha256", key).update(`${CONTEXT}${id}`).digest("base64url");
	return {
		sign(id) {
			if (!ID.test(id)) throw new Error("An unsubscribe id is 1-128 of [A-Za-z0-9_-]");
			return `${id}.${signature(id)}`;
		},
		verify(token) {
			const dot = token.indexOf(".");
			if (dot < 0) return null;
			const id = token.slice(0, dot);
			const given = token.slice(dot + 1);
			if (!ID.test(id) || !BASE64URL.test(given)) return null;
			const expected = Buffer.from(signature(id));
			const actual = Buffer.from(given);
			if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
			return id;
		},
	};
}

/** RFC 8058 one-click: mail clients POST to `oneClickUrl` without opening a page. */
export function unsubscribeHeaders(oneClickUrl: string): Record<string, string> {
	return {
		"List-Unsubscribe": `<${oneClickUrl}>`,
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	};
}

/** What the unsubscribe page reads and writes, keyed by a token from `UnsubscribeTokens`. */
export function createUnsubscribePage(options: {
	tokens: UnsubscribeTokens;
	store: Pick<EmailQueueStore, "get">;
	suppressions: SuppressionList;
}) {
	// a bad signature and an unknown job get the same answer
	async function jobOf(token: string): Promise<EmailJob | null> {
		const id = options.tokens.verify(token);
		return id ? options.store.get(id) : null;
	}
	return {
		/** the job the link was sent with and whether its address is suppressed; null: invalid link */
		async status(token: string): Promise<{ job: EmailJob; unsubscribed: boolean } | null> {
			const job = await jobOf(token);
			if (!job) return null;
			const reason = await options.suppressions.reason(job.orgId, job.recipient);
			return { job, unsubscribed: reason !== null };
		},
		/** suppresses the address (idempotent: an earlier reason stays); null: invalid link */
		async unsubscribe(token: string): Promise<EmailJob | null> {
			const job = await jobOf(token);
			if (!job) return null;
			await options.suppressions.suppress({
				orgId: job.orgId,
				address: job.recipient,
				reason: "unsubscribed",
				sourceJobId: job.id,
			});
			return job;
		},
	};
}
