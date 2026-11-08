import type { EventRecord } from "./define.ts";

/** An event as `emit` writes it. */
export type NewEvent = EventRecord;

export type DeliveryStatus = "pending" | "running" | "done" | "failed" | "dead";

/** One (event, subscriber) pair: there is at most one per pair. */
export interface Delivery {
	id: string;
	eventId: string;
	subscriber: string;
	status: DeliveryStatus;
	attempts: number;
	nextAttemptAt: Date;
	lastError: string | null;
	createdAt: Date;
	completedAt: Date | null;
	claimedAt: Date | null;
}

/** A delivery claimed by one runner; only the holder of `token` records its outcome. */
export interface DeliveryClaim {
	id: string;
	token: string;
}

export interface DeliveryOutcome {
	status: "done" | "failed" | "dead";
	attempts: number;
	lastError: string | null;
	/** when a failed delivery is due again */
	nextAttemptAt?: Date;
	completedAt?: Date;
}

/**
 * Due for retry: `failed` with `nextAttemptAt <= now`, or `pending` created before `staleBefore`,
 * or `running` claimed before `staleBefore` (a crashed runner).
 */
export interface DueFilter {
	now: Date;
	staleBefore: Date;
}

/**
 * The app's event tables. `@tatara/events/drizzle` implements it over Drizzle on Postgres and
 * `memoryEventStore` in memory; an app on another database implements these methods.
 */
export interface EventStore<Executor = unknown> {
	/** Writes events with the caller's transaction, so they exist exactly when it commits. */
	insertEvents(executor: Executor, events: readonly NewEvent[]): Promise<void>;
	/**
	 * In one transaction: locks up to `limit` unpublished events in outbox order (only `ids`, when
	 * given), skipping rows another relay holds; passes them to `publish`; marks published the ids
	 * it returns. Returns how many were marked. A failure leaves every row unpublished.
	 */
	relayBatch(
		options: { ids?: readonly string[]; limit: number; now: Date },
		publish: (events: { id: string; orgId: string | null }[]) => Promise<string[]>,
	): Promise<number>;
	findEvent(id: string): Promise<EventRecord | null>;
	/** Creates the delivery as `running` under `token`; null when the pair already has one. */
	claimNewDelivery(input: {
		eventId: string;
		subscriber: string;
		token: string;
		now: Date;
	}): Promise<string | null>;
	/** Ids of deliveries due for retry, oldest first. */
	dueDeliveries(input: DueFilter & { limit: number }): Promise<string[]>;
	/** Claims one delivery if it is still due; null when another runner took it. */
	claimDueDelivery(input: DueFilter & { id: string; token: string }): Promise<Delivery | null>;
	/** Records an outcome, only while `claim.token` still holds the delivery; clears the claim. */
	settleDelivery(claim: DeliveryClaim, outcome: DeliveryOutcome): Promise<void>;
	/**
	 * Ids of events named `names`, that occurred at or after `occurredSince` and were published at
	 * or before `publishedBefore`, with no delivery for `subscriber`; oldest first.
	 */
	missingDeliveries(input: {
		subscriber: string;
		names: readonly string[];
		occurredSince: Date;
		publishedBefore: Date;
		limit: number;
	}): Promise<string[]>;
	/** Creates `failed` deliveries due at `nextAttemptAt`, skipping pairs that exist; returns how many. */
	createDeliveries(
		rows: readonly {
			eventId: string;
			subscriber: string;
			nextAttemptAt: Date;
			lastError: string;
		}[],
	): Promise<number>;
	/** Deletes published events that occurred before `occurredBefore`, with their deliveries. */
	prune(input: { occurredBefore: Date }): Promise<number>;
	/** Makes `dead` deliveries `failed` and due at `now`; `subscriber` and `eventId` narrow it. */
	requeueDead(input: { now: Date; subscriber?: string; eventId?: string }): Promise<number>;
}
