# @tatara/temporal

## 0.1.0

### Minor Changes

- 23f6e48: Add the `temporal` add-on and `@tatara/temporal`: durable workflows on Temporal with a lazy client (idempotent starts, `TemporalUnavailableError` answered as 503), a worker app (`apps/temporal-worker`) that follows the app's shutdown, `workflows/`, `activities/` and `workflow-schedules/` module kinds discovered by `tatara sync`, schedules synced by the `temporal:schedules` deploy command, a local Temporal dev server in compose, and `make workflow | activity | workflow-schedule` generators.
