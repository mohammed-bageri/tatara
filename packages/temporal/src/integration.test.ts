import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createTemporal } from "./client.ts";
import { syncSchedules } from "./schedules.ts";
import { installRuntime } from "./worker.ts";

// Needs a Temporal dev server: docker run -p 7233:7233 temporalio/temporal server start-dev --ip 0.0.0.0
const address = process.env.TEMPORAL_TEST_ADDRESS;
const logger = pino({ level: "silent" });

describe.runIf(address)("against a Temporal dev server", () => {
	const taskQueue = `tatara-test-${Date.now()}`;
	const temporal = createTemporal({ address: address ?? "", namespace: "default", taskQueue });

	it("runs a workflow with an activity, and a start with the same id reuses it", async () => {
		installRuntime(logger);
		const connection = await NativeConnection.connect({ address: address ?? "" });
		const worker = await Worker.create({
			connection,
			taskQueue,
			workflowsPath: fileURLToPath(new URL("../test-fixtures/workflows.ts", import.meta.url)),
			activities: { greet: async (name: string) => `hello ${name}` },
		});
		const result = await worker.runUntil(async () => {
			const first = await temporal.start("greeting", {
				workflowId: `greet-${taskQueue}`,
				args: ["ada"],
			});
			const again = await temporal.start("greeting", {
				workflowId: `greet-${taskQueue}`,
				args: ["ada"],
			});
			expect(again.firstExecutionRunId).toBe(first.firstExecutionRunId);
			return first.result();
		});
		await connection.close();
		expect(result).toBe("hello ada");
	}, 60_000);

	it("syncs schedules", async () => {
		const client = await temporal.client();
		const id = `tatara-test-schedule-${Date.now()}`;
		const defs = [{ id, workflow: "greeting", cron: "0 0 1 1 *", args: ["new year"] }];
		const first = await syncSchedules(client.schedule, defs, { taskQueue, paused: true, logger });
		expect(first.created).toEqual([id]);
		const again = await syncSchedules(client.schedule, defs, { taskQueue, logger });
		expect(again.updated).toEqual([id]);
		const described = await client.schedule.getHandle(id).describe();
		expect(described.state.paused).toBe(true);
		const removed = await syncSchedules(client.schedule, [], { taskQueue, logger });
		expect(removed.deleted).toContain(id);
	}, 60_000);
});
