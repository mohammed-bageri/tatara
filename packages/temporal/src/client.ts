import { onShutdown } from "@tatara/core";
import {
	Client,
	Connection,
	type ConnectionOptions,
	type WorkflowHandleWithFirstExecutionRunId,
	type WorkflowHandleWithSignaledRunId,
	type WorkflowSignalWithStartOptions,
	type WorkflowStartOptions,
} from "@temporalio/client";
import type { Workflow } from "@temporalio/common";
import { isTemporalUnavailable, TemporalUnavailableError } from "./errors.ts";

export interface TemporalConfig {
	/** host:port of the frontend, e.g. localhost:7233 */
	address: string;
	namespace: string;
	/** the app's task queue: starts and schedules use it unless they name another */
	taskQueue: string;
	/** Temporal Cloud API key; turns TLS on */
	apiKey?: string;
	tls?: boolean;
	/** new schedules are created paused (set it outside production) */
	schedulesPaused?: boolean;
}

/** Connection settings shared by the client and the worker. */
export function connectionOptions(config: TemporalConfig): {
	address: string;
	tls?: boolean;
	apiKey?: string;
} {
	const tls = config.tls || Boolean(config.apiKey);
	return {
		address: config.address,
		...(tls ? { tls: true } : {}),
		...(config.apiKey ? { apiKey: config.apiKey } : {}),
	};
}

type StartOptions<T extends Workflow> = Omit<WorkflowStartOptions<T>, "taskQueue"> & {
	taskQueue?: string;
};
type SignalWithStartOptions<T extends Workflow, SA extends unknown[]> = Omit<
	WorkflowSignalWithStartOptions<SA>,
	"taskQueue"
> & { taskQueue?: string } & (Parameters<T> extends [] ? { args?: [] } : { args: Parameters<T> });

export interface Temporal {
	readonly config: TemporalConfig;
	/** the connected client, opened on first use and closed on shutdown */
	client(): Promise<Client>;
	/**
	 * Starts a workflow on the app's task queue. A start with the id of a running workflow returns
	 * that workflow (pass `workflowIdConflictPolicy: "FAIL"` to throw instead), so retried requests
	 * don't start twice. Throws TemporalUnavailableError when Temporal can't be reached.
	 */
	start<T extends Workflow>(
		workflow: string | T,
		options: StartOptions<T>,
	): Promise<WorkflowHandleWithFirstExecutionRunId<T>>;
	/** Signals the workflow, starting it first if it isn't running. */
	signalWithStart<T extends Workflow, SA extends unknown[] = []>(
		workflow: string | T,
		options: SignalWithStartOptions<T, SA>,
	): Promise<WorkflowHandleWithSignaledRunId<T>>;
	/** Sends a signal to a running workflow. */
	signal(workflowId: string, signal: string, ...args: unknown[]): Promise<void>;
	/** Throws unless the frontend answers; for readiness checks. */
	check(): Promise<void>;
}

export interface CreateTemporalOptions {
	/** replaces Connection.connect (tests) */
	connect?: (options: ConnectionOptions) => Promise<Connection>;
}

export function createTemporal(
	config: TemporalConfig,
	options: CreateTemporalOptions = {},
): Temporal {
	const connect = options.connect ?? ((o: ConnectionOptions) => Connection.connect(o));
	let pending: Promise<Client> | undefined;

	function client(): Promise<Client> {
		pending ??= connect(connectionOptions(config)).then(
			(connection) => {
				onShutdown("temporal client", () => connection.close());
				return new Client({ connection, namespace: config.namespace });
			},
			(error: unknown) => {
				// the next call tries again instead of failing forever
				pending = undefined;
				throw error;
			},
		);
		return pending;
	}

	async function guarded<R>(fn: (c: Client) => Promise<R>): Promise<R> {
		try {
			return await fn(await client());
		} catch (error) {
			if (isTemporalUnavailable(error)) {
				throw new TemporalUnavailableError("Temporal is unavailable", { cause: error });
			}
			throw error;
		}
	}

	return {
		config,
		client,
		start(workflow, startOptions) {
			return guarded((c) =>
				c.workflow.start(workflow, {
					workflowIdConflictPolicy: "USE_EXISTING",
					...startOptions,
					taskQueue: startOptions.taskQueue ?? config.taskQueue,
				} as WorkflowStartOptions<never>),
			);
		},
		signalWithStart(workflow, startOptions) {
			return guarded((c) =>
				c.workflow.signalWithStart(workflow, {
					...startOptions,
					taskQueue: startOptions.taskQueue ?? config.taskQueue,
				} as never),
			);
		},
		signal(workflowId, signal, ...args) {
			return guarded((c) => c.workflow.getHandle(workflowId).signal(signal, ...args));
		},
		async check() {
			await guarded((c) => c.connection.workflowService.getSystemInfo({}));
		},
	};
}
