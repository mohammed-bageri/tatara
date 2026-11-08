# @tatara/events

## 0.1.0

### Minor Changes

- ec0bab8: `@tatara/events`: a transactional domain-event outbox. `defineEvent` / `defineSubscriber`, `createEvents({ store, transaction, events, subscribers, jobs, logger })` with `emit` / `emitMany` in the caller's transaction, `transaction` (publishes right after commit), `afterCommit`, the relay (lock, publish to the `events.dispatch` job, mark), per-subscriber deliveries with retries and dead letters, the reconcile sweep, prune, and their consumer and schedules. An `EventStore` the app implements over its tables, with a Drizzle Postgres store (`@tatara/events/drizzle`) and a memory store; `events:relay`, `events:retry` and `events:requeue-dead` commands. New `events` add-on (Postgres + Drizzle; brings jobs and the cache): `tatara sync` lists `events/*.ts` and `event-subscribers/*.ts` into `src/generated/events.ts` (with `EventPayloads`) and `src/generated/subscribers.ts`.
