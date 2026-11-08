import { randomUUID } from "node:crypto";
import type { EventRecord } from "./define.ts";
import type { Delivery, DueFilter, EventStore, NewEvent } from "./store.ts";

/** A memory transaction: its events are stored when `transaction` resolves, dropped if it throws. */
export interface MemoryTransaction {
	readonly pending: NewEvent[];
}

interface StoredEvent extends NewEvent {
	seq: number;
	publishedAt: Date | null;
}

interface StoredDelivery extends Delivery {
	claimToken: string | null;
}

export interface MemoryEventStore extends EventStore<MemoryTransaction | undefined> {
	/** runs `fn` in a transaction the store commits or rolls back */
	transaction<T>(fn: (tx: MemoryTransaction) => Promise<T>): Promise<T>;
	readonly events: readonly (EventRecord & { seq: number; publishedAt: Date | null })[];
	readonly deliveries: readonly Delivery[];
}

/** An EventStore in memory, for tests. Outside a transaction (`undefined`), writes land at once. */
export function memoryEventStore(): MemoryEventStore {
	const events: StoredEvent[] = [];
	const deliveries: StoredDelivery[] = [];
	const locked = new Set<string>();
	let seq = 0;

	const isDue = (d: StoredDelivery, { now, staleBefore }: DueFilter) =>
		(d.status === "failed" && d.nextAttemptAt <= now) ||
		(d.status === "pending" && d.createdAt < staleBefore) ||
		(d.status === "running" && d.claimedAt !== null && d.claimedAt < staleBefore);

	const publicDelivery = ({ claimToken: _, ...d }: StoredDelivery): Delivery => ({ ...d });
	const publicEvent = ({ seq: _, publishedAt: __, ...e }: StoredEvent): EventRecord => ({ ...e });
	const store = (rows: readonly NewEvent[]) => {
		for (const row of rows) events.push({ ...row, seq: ++seq, publishedAt: null });
	};

	return {
		get events() {
			return events.map((e) => ({ ...e }));
		},
		get deliveries() {
			return deliveries.map(publicDelivery);
		},
		async transaction(fn) {
			const tx: MemoryTransaction = { pending: [] };
			const result = await fn(tx);
			store(tx.pending);
			return result;
		},
		async insertEvents(executor, rows) {
			if (executor) executor.pending.push(...rows);
			else store(rows);
		},
		async relayBatch({ ids, limit, now }, publish) {
			const batch = events
				.filter((e) => e.publishedAt === null && !locked.has(e.id) && (!ids || ids.includes(e.id)))
				.sort((a, b) => a.seq - b.seq)
				.slice(0, limit);
			for (const e of batch) locked.add(e.id);
			try {
				const done = new Set(await publish(batch.map((e) => ({ id: e.id, orgId: e.orgId }))));
				for (const e of batch) if (done.has(e.id)) e.publishedAt = now;
				return batch.filter((e) => done.has(e.id)).length;
			} finally {
				for (const e of batch) locked.delete(e.id);
			}
		},
		async findEvent(id) {
			const event = events.find((e) => e.id === id);
			return event ? publicEvent(event) : null;
		},
		async claimNewDelivery({ eventId, subscriber, token, now }) {
			if (deliveries.some((d) => d.eventId === eventId && d.subscriber === subscriber)) return null;
			const id = randomUUID();
			deliveries.push({
				id,
				eventId,
				subscriber,
				status: "running",
				attempts: 0,
				nextAttemptAt: now,
				lastError: null,
				createdAt: now,
				completedAt: null,
				claimedAt: now,
				claimToken: token,
			});
			return id;
		},
		async dueDeliveries({ limit, ...filter }) {
			return deliveries
				.filter((d) => isDue(d, filter))
				.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
				.slice(0, limit)
				.map((d) => d.id);
		},
		async claimDueDelivery({ id, token, ...filter }) {
			const d = deliveries.find((x) => x.id === id);
			if (!d || !isDue(d, filter)) return null;
			Object.assign(d, { status: "running", claimedAt: filter.now, claimToken: token });
			return publicDelivery(d);
		},
		async settleDelivery(claim, outcome) {
			const d = deliveries.find((x) => x.id === claim.id && x.claimToken === claim.token);
			if (!d) return;
			d.status = outcome.status;
			d.attempts = outcome.attempts;
			d.lastError = outcome.lastError;
			if (outcome.nextAttemptAt) d.nextAttemptAt = outcome.nextAttemptAt;
			if (outcome.completedAt) d.completedAt = outcome.completedAt;
			d.claimToken = null;
		},
		async missingDeliveries({ subscriber, names, occurredSince, publishedBefore, limit }) {
			return events
				.filter(
					(e) =>
						names.includes(e.name) &&
						e.occurredAt >= occurredSince &&
						e.publishedAt !== null &&
						e.publishedAt <= publishedBefore &&
						!deliveries.some((d) => d.eventId === e.id && d.subscriber === subscriber),
				)
				.sort((a, b) => a.seq - b.seq)
				.slice(0, limit)
				.map((e) => e.id);
		},
		async createDeliveries(rows) {
			let created = 0;
			for (const row of rows) {
				if (deliveries.some((d) => d.eventId === row.eventId && d.subscriber === row.subscriber))
					continue;
				deliveries.push({
					id: randomUUID(),
					eventId: row.eventId,
					subscriber: row.subscriber,
					status: "failed",
					attempts: 0,
					nextAttemptAt: row.nextAttemptAt,
					lastError: row.lastError,
					createdAt: row.nextAttemptAt,
					completedAt: null,
					claimedAt: null,
					claimToken: null,
				});
				created++;
			}
			return created;
		},
		async prune({ occurredBefore }) {
			const gone = new Set(
				events
					.filter((e) => e.publishedAt !== null && e.occurredAt < occurredBefore)
					.map((e) => e.id),
			);
			for (let i = events.length - 1; i >= 0; i--)
				if (gone.has((events[i] as StoredEvent).id)) events.splice(i, 1);
			for (let i = deliveries.length - 1; i >= 0; i--)
				if (gone.has((deliveries[i] as StoredDelivery).eventId)) deliveries.splice(i, 1);
			return gone.size;
		},
		async requeueDead({ now, subscriber, eventId }) {
			let count = 0;
			for (const d of deliveries) {
				if (d.status !== "dead") continue;
				if (subscriber && d.subscriber !== subscriber) continue;
				if (eventId && d.eventId !== eventId) continue;
				d.status = "failed";
				d.nextAttemptAt = now;
				count++;
			}
			return count;
		},
	};
}
