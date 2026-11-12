import { ServiceUnavailableError } from "@tatara/http";
import { createTemporal, TemporalUnavailableError } from "@tatara/temporal";
import { env } from "#core/config/env";

/** The app's Temporal client: `temporal.start(workflowFn, { workflowId, args })`, `temporal.signal(...)`. */
export const temporal = createTemporal({
	address: env.TEMPORAL_ADDRESS,
	namespace: env.TEMPORAL_NAMESPACE,
	taskQueue: env.TEMPORAL_TASK_QUEUE,
	apiKey: env.TEMPORAL_API_KEY,
	schedulesPaused: env.TEMPORAL_SCHEDULES_PAUSED,
});

/** For handleErrors: Temporal being down is a 503 the caller can retry, not a 500. */
export function mapTemporalErrors(err: unknown) {
	return err instanceof TemporalUnavailableError
		? new ServiceUnavailableError("Workflows are unavailable, try again shortly")
		: undefined;
}
