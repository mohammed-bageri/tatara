import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import type { EventActor, EventRecord } from "./define.ts";
import type { Delivery, DeliveryStatus, DueFilter, EventStore, NewEvent } from "./store.ts";

/** The app's events and deliveries tables (Postgres). */
export interface DrizzleEventTables {
	// biome-ignore lint/suspicious/noExplicitAny: any pgTable with the columns below
	events: any;
	// biome-ignore lint/suspicious/noExplicitAny: as above
	deliveries: any;
}

/** An events-table column, by the name the store uses. */
export type EventColumn = keyof NewEvent | "seq" | "publishedAt";

export interface DrizzleEventStoreOptions {
	/**
	 * The events table's property for a column when it differs, e.g. `{ orgId: "organizationId",
	 * name: "type", version: "schemaVersion" }` for tables that predate this package.
	 */
	columns?: Partial<Record<EventColumn, string>>;
}

const EVENT_COLUMNS: EventColumn[] = [
	"id",
	"seq",
	"name",
	"version",
	"orgId",
	"aggregateType",
	"aggregateId",
	"actor",
	"payload",
	"correlationId",
	"causationId",
	"depth",
	"occurredAt",
	"publishedAt",
];

const DELIVERY_COLUMNS = [
	"id",
	"eventId",
	"subscriber",
	"status",
	"attempts",
	"nextAttemptAt",
	"lastError",
	"createdAt",
	"completedAt",
	"claimedAt",
	"claimToken",
] as const;

/**
 * The EventStore over Drizzle on Postgres. `seq` must be an increasing serial (the outbox order),
 * deliveries need a unique index on (eventId, subscriber), and the relay locks rows with
 * `FOR NO KEY UPDATE SKIP LOCKED`. `Executor` is the app's `db | transaction` type.
 */
export function drizzleEventStore<Executor = unknown>(
	// biome-ignore lint/suspicious/noExplicitAny: a node-postgres (or compatible) drizzle database
	db: any,
	tables: DrizzleEventTables,
	options: DrizzleEventStoreOptions = {},
): EventStore<Executor> {
	const { events, deliveries } = tables;
	const prop = (column: EventColumn) => options.columns?.[column] ?? column;
	for (const column of EVENT_COLUMNS) {
		if (!events[prop(column)])
			throw new Error(`drizzleEventStore: the events table has no "${prop(column)}" column`);
	}
	for (const column of DELIVERY_COLUMNS) {
		if (!deliveries[column])
			throw new Error(`drizzleEventStore: the deliveries table has no "${column}" column`);
	}
	const E = (column: EventColumn) => events[prop(column)];
	const D = deliveries;

	const toRow = (event: NewEvent) =>
		Object.fromEntries(Object.entries(event).map(([k, v]) => [prop(k as EventColumn), v]));

	const toEvent = (row: Record<string, unknown>): EventRecord => ({
		id: row[prop("id")] as string,
		name: row[prop("name")] as string,
		version: row[prop("version")] as number,
		orgId: (row[prop("orgId")] as string | null) ?? null,
		aggregateType: (row[prop("aggregateType")] as string | null) ?? null,
		aggregateId: (row[prop("aggregateId")] as string | null) ?? null,
		actor: row[prop("actor")] as EventActor,
		payload: row[prop("payload")],
		correlationId: (row[prop("correlationId")] as string | null) ?? null,
		causationId: (row[prop("causationId")] as string | null) ?? null,
		depth: row[prop("depth")] as number,
		occurredAt: row[prop("occurredAt")] as Date,
	});

	const toDelivery = (row: Record<string, unknown>): Delivery => ({
		id: row.id as string,
		eventId: row.eventId as string,
		subscriber: row.subscriber as string,
		status: row.status as DeliveryStatus,
		attempts: row.attempts as number,
		nextAttemptAt: row.nextAttemptAt as Date,
		lastError: (row.lastError as string | null) ?? null,
		createdAt: row.createdAt as Date,
		completedAt: (row.completedAt as Date | null) ?? null,
		claimedAt: (row.claimedAt as Date | null) ?? null,
	});

	const due = ({ now, staleBefore }: DueFilter) =>
		or(
			and(eq(D.status, "failed"), lte(D.nextAttemptAt, now)),
			and(eq(D.status, "pending"), lt(D.createdAt, staleBefore)),
			and(eq(D.status, "running"), lt(D.claimedAt, staleBefore)),
		);

	return {
		async insertEvents(executor, rows) {
			if (rows.length === 0) return;
			// biome-ignore lint/suspicious/noExplicitAny: the app's db or transaction
			await (executor as any).insert(events).values(rows.map(toRow));
		},

		async relayBatch({ ids, limit, now }, publish) {
			// biome-ignore lint/suspicious/noExplicitAny: a drizzle transaction
			return db.transaction(async (tx: any) => {
				const rows: { id: string; orgId: string | null }[] = await tx
					.select({ id: E("id"), orgId: E("orgId") })
					.from(events)
					.where(and(isNull(E("publishedAt")), ids ? inArray(E("id"), [...ids]) : undefined))
					.orderBy(asc(E("seq")))
					.limit(limit)
					// NO KEY UPDATE: a dispatch inserting deliveries (a foreign-key share lock on the
					// event) never waits on the relay, even when the relay dispatches in its own process
					.for("no key update", { skipLocked: true });
				if (rows.length === 0) return 0;
				const published = await publish(rows);
				if (published.length > 0) {
					await tx
						.update(events)
						.set({ [prop("publishedAt")]: now })
						.where(inArray(E("id"), published));
				}
				return published.length;
			});
		},

		async findEvent(id) {
			const [row] = await db
				.select()
				.from(events)
				.where(eq(E("id"), id));
			return row ? toEvent(row) : null;
		},

		async claimNewDelivery({ eventId, subscriber, token, now }) {
			const [row] = await db
				.insert(deliveries)
				.values({
					id: randomUUID(),
					eventId,
					subscriber,
					status: "running",
					attempts: 0,
					nextAttemptAt: now,
					createdAt: now,
					claimedAt: now,
					claimToken: token,
				})
				.onConflictDoNothing()
				.returning({ id: D.id });
			return row?.id ?? null;
		},

		async dueDeliveries({ limit, ...filter }) {
			const rows: { id: string }[] = await db
				.select({ id: D.id })
				.from(deliveries)
				.where(due(filter))
				.orderBy(asc(D.createdAt))
				.limit(limit);
			return rows.map((r) => r.id);
		},

		async claimDueDelivery({ id, token, ...filter }) {
			const [row] = await db
				.update(deliveries)
				.set({ status: "running", claimedAt: filter.now, claimToken: token })
				.where(and(eq(D.id, id), due(filter)))
				.returning();
			return row ? toDelivery(row) : null;
		},

		async settleDelivery(claim, outcome) {
			await db
				.update(deliveries)
				.set({
					status: outcome.status,
					attempts: outcome.attempts,
					lastError: outcome.lastError,
					claimToken: null,
					...(outcome.nextAttemptAt ? { nextAttemptAt: outcome.nextAttemptAt } : {}),
					...(outcome.completedAt ? { completedAt: outcome.completedAt } : {}),
				})
				.where(and(eq(D.id, claim.id), eq(D.claimToken, claim.token)));
		},

		async missingDeliveries({ subscriber, names, occurredSince, publishedBefore, limit }) {
			if (names.length === 0) return [];
			const rows: { id: string }[] = await db
				.select({ id: E("id") })
				.from(events)
				.leftJoin(deliveries, and(eq(D.eventId, E("id")), eq(D.subscriber, subscriber)))
				.where(
					and(
						inArray(E("name"), [...names]),
						gte(E("occurredAt"), occurredSince),
						lte(E("publishedAt"), publishedBefore),
						isNull(D.id),
					),
				)
				.orderBy(asc(E("seq")))
				.limit(limit);
			return rows.map((r) => r.id);
		},

		async createDeliveries(rows) {
			if (rows.length === 0) return 0;
			const inserted: unknown[] = await db
				.insert(deliveries)
				.values(
					rows.map((r) => ({
						id: randomUUID(),
						eventId: r.eventId,
						subscriber: r.subscriber,
						status: "failed",
						attempts: 0,
						nextAttemptAt: r.nextAttemptAt,
						createdAt: r.nextAttemptAt,
						lastError: r.lastError,
					})),
				)
				.onConflictDoNothing()
				.returning({ id: D.id });
			return inserted.length;
		},

		async prune({ occurredBefore }) {
			const prunable = and(lt(E("occurredAt"), occurredBefore), isNotNull(E("publishedAt")));
			// biome-ignore lint/suspicious/noExplicitAny: a drizzle transaction
			return db.transaction(async (tx: any) => {
				// deliveries first: works whether or not their foreign key cascades
				await tx.delete(deliveries).where(
					inArray(
						D.eventId,
						tx
							.select({ id: E("id") })
							.from(events)
							.where(prunable),
					),
				);
				const deleted: unknown[] = await tx
					.delete(events)
					.where(prunable)
					.returning({ id: E("id") });
				return deleted.length;
			});
		},

		async requeueDead({ now, subscriber, eventId }) {
			const updated: unknown[] = await db
				.update(deliveries)
				.set({ status: "failed", nextAttemptAt: now })
				.where(
					and(
						eq(D.status, "dead"),
						subscriber ? eq(D.subscriber, subscriber) : undefined,
						eventId ? eq(D.eventId, eventId) : undefined,
					),
				)
				.returning({ id: D.id });
			return updated.length;
		},
	};
}
