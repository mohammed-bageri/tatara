import { fileURLToPath } from "node:url";
import { installRuntime } from "@tatara/temporal/worker";
import { NativeConnection, Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import { env } from "#core/config/env";
import { logger } from "#core/logging/logger";
import { temporal } from "#core/temporal/index";
import { activities } from "#generated/activities";
import { exampleGreeting } from "#generated/workflows";

const workflowsPath = fileURLToPath(new URL("../../../generated/workflows.ts", import.meta.url));

describe("temporal", () => {
	it("runs a workflow and its activity", async () => {
		// a queue of its own, so no other worker picks the task up
		const taskQueue = `test-${crypto.randomUUID()}`;
		installRuntime(logger);
		const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });
		const worker = await Worker.create({ connection, taskQueue, workflowsPath, activities });
		const result = await worker.runUntil(async () => {
			const handle = await temporal.start(exampleGreeting, {
				workflowId: `example-greeting-${taskQueue}`,
				taskQueue,
				args: ["Ada"],
			});
			return handle.result();
		});
		await connection.close();
		expect(result).toBe("Hello, Ada!");
	}, 60_000);
});
