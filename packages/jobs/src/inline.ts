import type { CoreLogger } from "@tatara/core";
import type { ConsumerDefinition, JobEnvelope } from "./define.ts";
import type { JobDriver } from "./driver.ts";
import { type JobOutboxOptions, jobOutbox } from "./outbox.ts";
import type { Queryable } from "./postgres.ts";
import { type JobHandler, jobHandler } from "./runner.ts";

export interface InlineDriver extends JobDriver {
	/**
	 * Resolves once every job sent so far, and every retry, has finished; with an `outbox`, also the
	 * jobs of transactions that have committed.
	 */
	drain(): Promise<void>;
	/** jobs that ended dead, newest last */
	readonly dead: JobEnvelope[];
}

/**
 * Runs jobs in this process, right after they're sent: for tests and for development without a
 * worker. Nothing survives a restart. `retryDelay` lets tests skip the backoff.
 */
export function inlineDriver(options: {
	/** or a function that loads them on first send, so the producer needn't import them */
	consumers: readonly ConsumerDefinition[] | (() => Promise<readonly ConsumerDefinition[]>);
	logger: CoreLogger;
	retryDelay?: (delayMs: number) => number;
	/**
	 * Jobs enqueued with an `executor` wait in this outbox until their transaction commits (see
	 * `jobOutbox`). Without one they run right away, committed or not.
	 */
	outbox?: JobOutboxOptions;
	/** the outbox rows this driver forwards (default "default"); two inline drivers on one database need two */
	name?: string;
}): InlineDriver {
	let handler: Promise<JobHandler> | undefined;
	const handle = async (job: JobEnvelope) => {
		const { consumers } = options;
		handler ??= (async () =>
			jobHandler(
				typeof consumers === "function" ? await consumers() : consumers,
				options.logger,
			))();
		return (await handler)(job);
	};
	const pending = new Set<Promise<void>>();
	const dead: JobEnvelope[] = [];

	const schedule = (job: JobEnvelope, delayMs: number) => {
		const run = new Promise<void>((resolve) => {
			setTimeout(async () => {
				const outcome = await handle(job);
				if (outcome.status === "retry")
					schedule(
						{ ...job, attempt: job.attempt + 1 },
						options.retryDelay ? options.retryDelay(outcome.delayMs) : outcome.delayMs,
					);
				if (outcome.status === "dead") dead.push(job);
				resolve();
			}, delayMs);
		});
		pending.add(run);
		void run.then(() => pending.delete(run));
	};
	const outbox = options.outbox
		? jobOutbox(options.outbox, `inline:${options.name ?? "default"}`, async (jobs) => {
				for (const { job, delayMs } of jobs) schedule(job, delayMs);
			})
		: undefined;

	return {
		name: "inline",
		dead,
		async send(jobs, executor) {
			if (executor !== undefined && outbox) return outbox.write(jobs, executor as Queryable);
			for (const { job, delayMs } of jobs) schedule(job, delayMs);
		},
		async consume() {
			// jobs already run where they're sent
			return async () => {};
		},
		async drain() {
			for (;;) {
				const forwarded = outbox ? await outbox.forward() : 0;
				if (forwarded === 0 && pending.size === 0) return;
				while (pending.size > 0) await Promise.all([...pending]);
			}
		},
	};
}
