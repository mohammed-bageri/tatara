/** @tatara/temporal: client, guarded starts, activity sets and schedules. The worker is in `@tatara/temporal/worker`. */
export { type ActivitySet, defineActivities, mergeActivities } from "./activities.ts";
export {
	type CreateTemporalOptions,
	connectionOptions,
	createTemporal,
	type Temporal,
	type TemporalConfig,
} from "./client.ts";
export { isTemporalUnavailable, TemporalUnavailableError } from "./errors.ts";
export {
	defineWorkflowSchedule,
	type SyncResult,
	type SyncSchedulesOptions,
	syncSchedules,
	type WorkflowScheduleDefinition,
} from "./schedules.ts";
