import { createEvents } from "@tatara/events";
import { drizzleEventStore } from "@tatara/events/drizzle";
import { db, type Executor } from "#core/db/client";
import { domainEventDeliveries, domainEvents } from "#core/events/db/events.schema";
import { jobs } from "#core/jobs/index";
import { logger } from "#core/logging/logger";
import { events as definitions } from "#generated/events";

/**
 * The app's domain events over its tables (events.schema.ts): `events.emit(tx, event, input)` in
 * the transaction that makes the change, `events.transaction(fn)` to publish right after commit.
 */
export const events = createEvents({
	store: drizzleEventStore<Executor>(db, { events: domainEvents, deliveries: domainEventDeliveries }),
	transaction: (fn) => db.transaction(fn),
	events: definitions,
	// loaded on first dispatch: a subscriber may import this file to emit
	subscribers: async () => (await import("#generated/subscribers")).subscribers,
	jobs,
	logger,
});
