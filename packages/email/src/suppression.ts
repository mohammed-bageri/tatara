/** Per-organization addresses that must not get email: bounced, complained or unsubscribed. */
import { createHash } from "node:crypto";
import type { EmailMessage, Mailer, SentEmail } from "./mailer.ts";

export const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "complained"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Unpeppered on purpose: rotating a secret must not silently empty every list. */
export function emailHash(address: string): string {
	return createHash("sha256").update(address.trim().toLowerCase()).digest("hex");
}

/**
 * The app's suppression table, keyed by `emailHash(address)` so it can outlive an erased person
 * without keeping the address.
 */
export interface SuppressionStore {
	/** the reasons recorded for those hashes in the org; hashes without one are absent */
	find(orgId: string, hashes: readonly string[]): Promise<Map<string, SuppressionReason>>;
	/** records it unless the org already has that hash: the first reason stays */
	add(entry: {
		orgId: string;
		hash: string;
		reason: SuppressionReason;
		/** the queued email it came from, when known */
		sourceJobId: string | null;
	}): Promise<void>;
}

export type SuppressedSend =
	| (SentEmail & { suppressed?: never })
	| { suppressed: SuppressionReason };

export interface SuppressionList {
	reason(orgId: string, address: string): Promise<SuppressionReason | null>;
	/** the suppressed ones among `addresses`, by address as given */
	reasons(orgId: string, addresses: readonly string[]): Promise<Map<string, SuppressionReason>>;
	suppress(input: {
		orgId: string;
		address: string;
		reason: SuppressionReason;
		sourceJobId?: string | null;
	}): Promise<void>;
	/** sends through `mailer` unless the one recipient is suppressed in the org */
	send(
		mailer: Mailer,
		orgId: string,
		message: EmailMessage & { to: string },
	): Promise<SuppressedSend>;
}

export function createSuppressionList(store: SuppressionStore): SuppressionList {
	async function reasons(orgId: string, addresses: readonly string[]) {
		const byHash = new Map(addresses.map((a) => [emailHash(a), a]));
		const found = byHash.size ? await store.find(orgId, [...byHash.keys()]) : new Map();
		const out = new Map<string, SuppressionReason>();
		for (const [hash, reason] of found) {
			const address = byHash.get(hash);
			if (address !== undefined) out.set(address, reason);
		}
		return out;
	}
	async function reason(orgId: string, address: string) {
		return (await reasons(orgId, [address])).get(address) ?? null;
	}
	return {
		reason,
		reasons,
		async suppress(input) {
			await store.add({
				orgId: input.orgId,
				hash: emailHash(input.address),
				reason: input.reason,
				sourceJobId: input.sourceJobId ?? null,
			});
		},
		async send(mailer, orgId, message) {
			const suppressed = await reason(orgId, message.to);
			if (suppressed) return { suppressed };
			return mailer.send(message);
		},
	};
}
