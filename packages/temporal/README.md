# @tatara/temporal

Part of [tatara](https://github.com/mohammed-bageri/tatara). `tatara new --addons temporal` wires it up.

Durable workflows on [Temporal](https://temporal.io) for work that waits on people or outside
systems: a lazy client with guarded starts, a worker runner that follows the app's shutdown,
activity sets merged from every module, and schedules synced on deploy.

## Client

```ts
import { createTemporal } from "@tatara/temporal";

export const temporal = createTemporal({
	address: env.TEMPORAL_ADDRESS, // localhost:7233
	namespace: env.TEMPORAL_NAMESPACE,
	taskQueue: env.TEMPORAL_TASK_QUEUE, // starts and schedules use it unless they name another
	apiKey: env.TEMPORAL_API_KEY, // Temporal Cloud; turns TLS on
	schedulesPaused: env.TEMPORAL_SCHEDULES_PAUSED, // new schedules start paused outside production
});

const handle = await temporal.start(approvalFlow, { workflowId: `approval-${id}`, args: [id] });
await temporal.signal(`approval-${id}`, "approve", { by: userId });
await temporal.signalWithStart(approvalFlow, { workflowId, args: [id], signal: "approve", signalArgs: [] });
```

- The connection opens on first use and closes on shutdown. A failed connect is retried on the next call.
- **Starting an id that is already running returns that workflow**, so a retried request doesn't
  start twice. Pass `workflowIdConflictPolicy: "FAIL"` to throw instead.
- When Temporal can't be reached, calls throw `TemporalUnavailableError`. Map it to 503: the work the
  request already did stays done, and the caller can retry the start.
- `temporal.check()` is a readiness check.

## Activities

```ts
// src/modules/billing/activities/invoices.ts
export default defineActivities({
	async createInvoice(orderId: string) { … },
});
```

`mergeActivities(...sets)` (what `tatara sync` generates) builds the worker's map and throws on two
activities with one name. Workflows take their types from the merged map:
`proxyActivities<Activities>({ startToCloseTimeout: "1 minute" })`.

## Worker

```ts
import { startTemporalWorker, workflowsPath } from "@tatara/temporal/worker";

await startTemporalWorker({
	temporal,
	workflowsPath: workflowsPath(import.meta.url, {
		source: "../../generated/workflows.ts", // tatara dev
		built: "../../workflows.mjs", // dist
	}),
	activities,
	logger,
});
handleSignals(logger);
```

SDK logs go through the app's logger, and SIGTERM/SIGINT stay with the app's lifecycle. Shutdown
drains in-flight tasks and then closes the connection. If the worker stops on its own, the process
exits 1 so the supervisor restarts it.

## Schedules

```ts
// src/modules/billing/workflow-schedules/nightly.ts
export default defineWorkflowSchedule({
	id: "billing.nightly-invoices",
	workflow: "nightlyInvoices",
	cron: "0 2 * * *",
	timezone: "Asia/Riyadh",
});
```

`syncSchedules` (the `temporal:schedules` deploy command) makes Temporal match the app:

- It creates new schedules, paused when `schedulesPaused` is set.
- It updates the spec, action and overlap policy of existing ones, and keeps their paused state.
- It deletes schedules it created earlier that the app no longer declares. Schedules made by hand
  are only updated, never deleted.

## Commands

- `temporal:schedules` runs on every deploy.
- `temporal:start --workflow <type> --id <id> --args '[…]'` starts a workflow by hand.

## Tests

The integration tests need a dev server:
`docker run -p 7233:7233 temporalio/temporal server start-dev --ip 0.0.0.0`, then
`TEMPORAL_TEST_ADDRESS=localhost:7233 pnpm vitest run packages/temporal`.
