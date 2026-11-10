# @tatara/events

## 0.2.0

### Minor Changes

- a87e93e: Core holds no tables: new apps keep authz and events in src/modules/authz and src/modules/events, and `tatara upgrade` moves existing apps there (0.20 codemod). `tatara check` lets a module import another module's tables (db/) as well as its services. `createI18n({ searchNamespaces: true })` finds a key without a namespace inside every namespace, so modules own their error strings. `tatara new --help` lists every add-on.

## 0.1.2

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.
- Updated dependencies [9b9ac7f]
  - @tatara/core@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [1882c35]
  - @tatara/core@0.2.0

## 0.1.0

### Minor Changes

- ec0bab8: `@tatara/events`: a transactional domain-event outbox. `defineEvent` / `defineSubscriber`, `createEvents({ store, transaction, events, subscribers, jobs, logger })` with `emit` / `emitMany` in the caller's transaction, `transaction` (publishes right after commit), `afterCommit`, the relay (lock, publish to the `events.dispatch` job, mark), per-subscriber deliveries with retries and dead letters, the reconcile sweep, prune, and their consumer and schedules. An `EventStore` the app implements over its tables, with a Drizzle Postgres store (`@tatara/events/drizzle`) and a memory store; `events:relay`, `events:retry` and `events:requeue-dead` commands. New `events` add-on (Postgres + Drizzle; brings jobs and the cache): `tatara sync` lists `events/*.ts` and `event-subscribers/*.ts` into `src/generated/events.ts` (with `EventPayloads`) and `src/generated/subscribers.ts`.
