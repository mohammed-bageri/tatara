import type { CoreLogger } from "@tatara/core";
import type {
	ScheduleClient,
	ScheduleOptions,
	ScheduleOverlapPolicy,
	ScheduleUpdateOptions,
} from "@temporalio/client";

export interface WorkflowScheduleDefinition {
	/** schedule id, unique in the namespace, e.g. "billing.nightly-invoices" */
	id: string;
	description?: string;
	/** the workflow type: its exported function name */
	workflow: string;
	/** one or more cron expressions */
	cron: string | string[];
	/** IANA zone the cron reads in (default UTC) */
	timezone?: string;
	args?: unknown[];
	/** defaults to the app's task queue */
	taskQueue?: string;
	/** what happens when a run is still going at the next time (default SKIP) */
	overlap?: ScheduleOverlapPolicy;
}

/** Default export of every `workflow-schedules/*.ts`; synced to Temporal on deploy. */
export function defineWorkflowSchedule<const D extends WorkflowScheduleDefinition>(
	definition: D,
): D {
	return definition;
}

/** memo on every schedule tatara creates, so a sync only deletes its own */
const MEMO_KEY = "tatara";
const MANAGED = "managed";

export interface SyncSchedulesOptions {
	taskQueue: string;
	/** create new schedules paused (updates never change paused) */
	paused?: boolean;
	logger: CoreLogger;
}

export interface SyncResult {
	created: string[];
	updated: string[];
	deleted: string[];
}

type Schedules = Pick<ScheduleClient, "create" | "getHandle" | "list">;

function isAlreadyExists(error: unknown): boolean {
	return (error as { name?: unknown } | null)?.name === "ScheduleAlreadyRunning";
}

/**
 * Makes Temporal's schedules match the app's: creates new ones, updates the spec and action of
 * existing ones (pause state and policies people changed are kept), and deletes schedules tatara
 * created earlier that the app no longer declares. Safe to run on every deploy.
 */
export async function syncSchedules(
	schedules: Schedules,
	definitions: readonly WorkflowScheduleDefinition[],
	options: SyncSchedulesOptions,
): Promise<SyncResult> {
	const ids = new Set<string>();
	for (const d of definitions) {
		if (ids.has(d.id)) throw new Error(`Duplicate workflow schedule "${d.id}"`);
		ids.add(d.id);
	}

	const managed = new Set<string>();
	for await (const summary of schedules.list()) {
		if (summary.memo?.[MEMO_KEY] === MANAGED) managed.add(summary.scheduleId);
	}

	const result: SyncResult = { created: [], updated: [], deleted: [] };
	for (const d of definitions) {
		const spec = { cronExpressions: [d.cron].flat(), timezone: d.timezone };
		const action = {
			type: "startWorkflow" as const,
			workflowType: d.workflow,
			args: d.args ?? [],
			taskQueue: d.taskQueue ?? options.taskQueue,
			workflowId: d.id,
		};
		const update = async () => {
			await schedules.getHandle(d.id).update(
				(previous) =>
					({
						...previous,
						spec,
						action,
						policies: { ...previous.policies, overlap: d.overlap ?? "SKIP" },
					}) as ScheduleUpdateOptions,
			);
			result.updated.push(d.id);
		};
		if (managed.has(d.id)) {
			await update();
			continue;
		}
		try {
			await schedules.create({
				scheduleId: d.id,
				spec,
				action,
				policies: { overlap: d.overlap ?? "SKIP" },
				state: { paused: options.paused ?? false, note: d.description },
				memo: { [MEMO_KEY]: MANAGED },
			} as ScheduleOptions);
			result.created.push(d.id);
		} catch (error) {
			// made by hand or by an older sync without the memo: take it over
			if (!isAlreadyExists(error)) throw error;
			await update();
		}
	}

	for (const id of managed) {
		if (ids.has(id)) continue;
		await schedules.getHandle(id).delete();
		result.deleted.push(id);
	}
	options.logger.info(result, "temporal schedules synced");
	return result;
}
