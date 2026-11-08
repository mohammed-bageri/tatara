# @tatara/events

A transactional domain-event outbox. A module records "this happened" in the transaction that
makes the change, and other modules react to it later, each on its own.

Part of [tatara](https://github.com/mohammed-bageri/tatara-cli). `tatara new --addons events`
(Postgres + Drizzle) wires all of this up.

## Guarantees

- **Same transaction.** An event is a row written with the business change. If the transaction
  rolls back, the event never existed. Payloads are validated against the definition's schema
  at emit time.
- **At-least-once, per subscriber.** The relay locks unpublished events (`SKIP LOCKED`), hands
  each to the worker (`events.dispatch` job, or dispatches in-process without jobs), and marks
  the ones that made it before committing. A crash leaves them unpublished, so an event can be
  published twice but is never lost.
- **One delivery per (event, subscriber).** A failing subscriber is retried alone with backoff
  (`min(2^n × 15s, 1h)`) and is `dead` after 8 attempts. The others are not re-run.
- **Subscribers must be idempotent per `event.id`.** A redelivery, or a handler that outlives
  its 5-minute claim, can run it again.
- **No ordering.** Failed publishes and deliveries retry while newer events go ahead.

## Define

```ts
// src/modules/billing/events/invoice.ts
export default defineEvent({
	name: "billing.invoice.paid", // dotted lowercase, unique
	version: 1, // default 1; bump for a breaking payload change
	aggregateType: "invoice",
	schema: z.object({ invoiceId: z.string() }).strict(),
});

// src/modules/notifications/event-subscribers/receipt.ts
export default defineSubscriber({
	name: "notifications.receipt", // unique; stored on each delivery
	event: invoicePaid, // or [a, b], or event names
	async handle(event, { logger, attempt }) {
		event.payload.invoiceId; // typed from the definition
	},
});
```

A definition keeps any extra fields you give it (`labelKey`, …). `tatara sync` lists
`src/{core,modules}/*/events/*.ts` (default export: one definition or an array) into
`src/generated/events.ts` (with `EventPayloads`) and `*/event-subscribers/*.ts` into
`src/generated/subscribers.ts`.

## Use

```ts
export const events = createEvents({
	store: drizzleEventStore<Executor>(db, { events: domainEvents, deliveries: domainEventDeliveries }),
	transaction: (fn) => db.transaction(fn),
	events: definitions, // #generated/events: lets emit take a name, checks subscribers
	subscribers: async () => (await import("#generated/subscribers")).subscribers,
	jobs, // optional: without it the relay dispatches in its own process
	logger,
});

await events.transaction(async (tx) => {
	await tx.update(invoices).set({ paidAt }).where(eq(invoices.id, id));
	await events.emit(tx, invoicePaid, { payload: { invoiceId: id }, orgId, aggregateId: id, actor });
	events.afterCommit(async () => removeTempFiles()); // after commit only; errors are logged
});
```

- `emit(executor, definition | name, { payload, orgId?, aggregateId?, actor?, cause? })` → id;
  `emitMany` writes many of one definition (1,000 rows per insert).
- Inside `events.transaction` the events are published right after commit. In a plain
  transaction the `events-relay` schedule publishes them within seconds.
- `cause: causedBy(event)` records causation, correlation and `depth` for chains.
- `relay()`, `dispatch(eventId)`, `retry()`, `reconcile()`, `prune()`, `requeueDead(filter)`.
- `events.consumer` (the `events.dispatch` job) and `events.schedules.{relay, retry, reconcile,
  prune}` are default-exported by the app's `consumers/` and `schedules/` files.

| Schedule | Cron | Does |
|---|---|---|
| `events-relay` | every 5s | publishes events the fast path missed (200 a batch) |
| `events-retry` | every 30s | runs due failures and claims older than 5 minutes |
| `events-reconcile` | every minute | creates deliveries a dispatcher skipped (a subscriber only newer code has), for events published over 2 minutes ago within the last 30 |
| `events-prune` | 03:15 daily | deletes published events older than 13 months, with their deliveries |

Each publish to jobs is bounded (2.5s); after a timeout the post-commit fast path pauses for
30s, and the sweep keeps going. A delivery whose subscriber this process does not have backs off
like a failure. Commands: `events:relay`, `events:retry`, `events:requeue-dead [--subscriber]
[--event]` (attempts are kept).

## Stores

`EventStore` is the app's tables: `insertEvents` (in the caller's transaction), `relayBatch`,
`findEvent`, `claimNewDelivery`, `dueDeliveries`, `claimDueDelivery`, `settleDelivery`,
`missingDeliveries`, `createDeliveries`, `prune`, `requeueDead`. See `src/store.ts`.

- `drizzleEventStore(db, tables, { columns? })` from `@tatara/events/drizzle`, for Postgres.
  `columns` maps the store's names to other properties, for tables that predate the package:
  `{ orgId: "organizationId", name: "type", version: "schemaVersion" }`.
- `memoryEventStore()` for tests; `store.transaction(fn)` commits or drops its events.
