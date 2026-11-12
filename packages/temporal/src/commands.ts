import { type CommandDefinition, defineCommand } from "@tatara/core";
import { z } from "zod";
import type { Temporal } from "./client.ts";
import { syncSchedules, type WorkflowScheduleDefinition } from "./schedules.ts";

/** temporal:schedules (on every deploy) and temporal:start; wired into the app by `tatara sync`. */
export function temporalCommands({
	temporal,
	workflowSchedules,
}: {
	temporal: Temporal;
	workflowSchedules: readonly WorkflowScheduleDefinition[];
}): CommandDefinition[] {
	return [
		defineCommand({
			name: "temporal:schedules",
			description: "Create, update and delete the app's Temporal schedules (runs on every deploy)",
			phase: "deploy",
			async run(_args, { logger }) {
				const client = await temporal.client();
				await syncSchedules(client.schedule, workflowSchedules, {
					taskQueue: temporal.config.taskQueue,
					paused: temporal.config.schedulesPaused,
					logger,
				});
			},
		}),
		defineCommand({
			name: "temporal:start",
			description: "Start a workflow by type with JSON args (for development and debugging)",
			args: z.object({
				workflow: z.string().min(1),
				id: z.string().min(1),
				args: z.string().default("[]"),
			}),
			async run({ workflow, id, args }, { logger }) {
				const parsed = JSON.parse(args) as unknown;
				if (!Array.isArray(parsed)) throw new Error("--args must be a JSON array");
				const handle = await temporal.start(workflow, { workflowId: id, args: parsed });
				logger.info({ workflow, workflowId: handle.workflowId }, "workflow started");
			},
		}),
	] as CommandDefinition[];
}
