import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

const ts = () => timestamp({ withTimezone: true, mode: "date" });

/** The outbox: one row per event, written in the transaction that made the change. */
export const domainEvents = pgTable(
	"domain_events",
	{
		id: uuid().primaryKey(),
		/** outbox order: the relay publishes in it */
		seq: bigserial({ mode: "number" }).notNull(),
		name: varchar({ length: 120 }).notNull(),
		version: integer().notNull(),
		orgId: text(),
		aggregateType: varchar({ length: 64 }),
		aggregateId: text(),
		actor: jsonb().notNull(),
		payload: jsonb().notNull(),
		correlationId: uuid(),
		causationId: uuid(),
		depth: integer().notNull().default(0),
		occurredAt: ts().notNull().defaultNow(),
		/** null until the relay has handed the event to the worker */
		publishedAt: ts(),
	},
	(t) => [
		index("domain_events_relay").on(t.publishedAt, t.seq),
		index("domain_events_name_occurred").on(t.name, t.occurredAt),
		index("domain_events_aggregate").on(t.aggregateType, t.aggregateId),
		index("domain_events_occurred").on(t.occurredAt),
	],
);

/** One row per (event, subscriber): each subscriber runs and retries on its own. */
export const domainEventDeliveries = pgTable(
	"domain_event_deliveries",
	{
		id: uuid().primaryKey(),
		eventId: uuid()
			.notNull()
			.references(() => domainEvents.id, { onDelete: "cascade" }),
		subscriber: varchar({ length: 160 }).notNull(),
		/** pending | running | done | failed | dead */
		status: varchar({ length: 16 }).notNull().default("pending"),
		attempts: integer().notNull().default(0),
		nextAttemptAt: ts().notNull().defaultNow(),
		lastError: text(),
		createdAt: ts().notNull().defaultNow(),
		completedAt: ts(),
		claimedAt: ts(),
		/** set by the runner that claimed the row; only it records the outcome */
		claimToken: uuid(),
	},
	(t) => [
		uniqueIndex("domain_event_deliveries_pair").on(t.eventId, t.subscriber),
		index("domain_event_deliveries_due").on(t.status, t.nextAttemptAt),
	],
);
