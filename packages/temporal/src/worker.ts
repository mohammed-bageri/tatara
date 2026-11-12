/** @tatara/temporal/worker: runs the app's workflows and activities; only the worker process imports it. */
import { fileURLToPath } from "node:url";
import { type CoreLogger, onShutdown, shutdown } from "@tatara/core";
import type { Logger, LogLevel, LogMetadata } from "@temporalio/common";
import { NativeConnection, Runtime, Worker, type WorkerOptions } from "@temporalio/worker";
import { connectionOptions, type TemporalConfig } from "./client.ts";

const LEVELS: Record<LogLevel, "trace" | "debug" | "info" | "warn" | "error"> = {
	TRACE: "trace",
	DEBUG: "debug",
	INFO: "info",
	WARN: "warn",
	ERROR: "error",
};

/** The SDK's logger interface over the app's pino logger. */
export function sdkLogger(logger: CoreLogger): Logger {
	const at = (level: LogLevel) => (message: string, meta?: LogMetadata) =>
		logger[LEVELS[level]](meta ?? {}, message);
	return {
		log: (level, message, meta) => at(level)(message, meta),
		trace: at("TRACE"),
		debug: at("DEBUG"),
		info: at("INFO"),
		warn: at("WARN"),
		error: at("ERROR"),
	};
}

let runtimeInstalled = false;

/** Routes SDK logs through the app's logger; signals stay with the app's lifecycle. */
export function installRuntime(logger: CoreLogger): void {
	if (runtimeInstalled) return;
	Runtime.install({ logger: sdkLogger(logger), shutdownSignals: [] });
	runtimeInstalled = true;
}

/**
 * The workflows file the worker bundles: the TypeScript source when the worker runs from `src`
 * (`tatara dev`), the built file when it runs from `dist`.
 */
export function workflowsPath(moduleUrl: string, paths: { source: string; built: string }): string {
	const relative = moduleUrl.endsWith(".ts") ? paths.source : paths.built;
	return fileURLToPath(new URL(relative, moduleUrl));
}

export interface StartWorkerOptions
	extends Omit<WorkerOptions, "connection" | "namespace" | "taskQueue" | "workflowsPath"> {
	temporal: { config: TemporalConfig };
	workflowsPath: string;
	logger: CoreLogger;
	/** defaults to the app's task queue */
	taskQueue?: string;
}

/**
 * Connects, starts polling and returns the running worker. Shutdown drains in-flight tasks and
 * closes the connection; if the worker stops on its own (a fatal error), the process exits 1.
 */
export async function startTemporalWorker(options: StartWorkerOptions): Promise<Worker> {
	const { temporal, logger, taskQueue, ...rest } = options;
	installRuntime(logger);
	const connection = await NativeConnection.connect(connectionOptions(temporal.config));
	const queue = taskQueue ?? temporal.config.taskQueue;
	const worker = await Worker.create({
		...rest,
		connection,
		namespace: temporal.config.namespace,
		taskQueue: queue,
	});
	let stopping = false;
	const running = worker.run().then(
		() => {
			if (!stopping) void shutdown(1, logger);
		},
		(err: unknown) => {
			logger.error({ err }, "temporal worker stopped");
			void shutdown(1, logger);
		},
	);
	onShutdown("temporal worker", async () => {
		stopping = true;
		if (worker.getState() === "RUNNING") worker.shutdown();
		await running;
		await connection.close();
	});
	logger.info(
		{ taskQueue: queue, namespace: temporal.config.namespace },
		"temporal worker started",
	);
	return worker;
}
