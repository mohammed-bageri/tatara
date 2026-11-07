import { onShutdown } from "@tatara/core";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { JobEnvelope } from "./define.ts";
import type { JobDriver, Outgoing } from "./driver.ts";

export interface BullmqDriverOptions {
	/** queue name; dead jobs go to `<name>-dead`, kept for inspection (e.g. in a Bull Board) */
	name: string;
	prefix: string;
	/** BullMQ needs maxRetriesPerRequest: null; `lazyRedis` gives one */
	redis: () => Redis;
}

const KEEP = { removeOnComplete: 1000, removeOnFail: 5000 };

/** Jobs in Redis through BullMQ. Each attempt is its own BullMQ job, so retries keep the envelope. */
export function bullmqDriver(options: BullmqDriverOptions): JobDriver {
	const queues = new Map<string, Queue>();
	const queue = (name: string) => {
		let q = queues.get(name);
		if (!q) {
			const created = new Queue(name, { connection: options.redis(), prefix: options.prefix });
			q = created;
			queues.set(name, created);
			onShutdown(`queue:${name}`, () => created.close());
		}
		return q;
	};
	const add = (name: string, jobs: Outgoing[]) =>
		queue(name).addBulk(
			jobs.map(({ job, delayMs }) => ({
				name: job.topic,
				data: job,
				// "-" because BullMQ ids may not contain ":"
				opts: { jobId: `${job.id}-${job.attempt}`, delay: delayMs, attempts: 1, ...KEEP },
			})),
		);

	return {
		name: "bullmq",
		async send(jobs, executor) {
			if (executor !== undefined) {
				throw new Error(
					"BullMQ driver can't enqueue inside a transaction; use the Postgres driver or enqueue after commit",
				);
			}
			await add(options.name, jobs);
		},
		async consume(handle, { concurrency, logger }) {
			const worker = new Worker<JobEnvelope>(
				options.name,
				async (bullJob) => {
					const job = bullJob.data;
					const outcome = await handle(job);
					if (outcome.status === "retry")
						await add(options.name, [
							{ job: { ...job, attempt: job.attempt + 1 }, delayMs: outcome.delayMs },
						]);
					if (outcome.status === "dead")
						await queue(`${options.name}-dead`).add(
							job.topic,
							{ ...job, error: String(outcome.error) },
							{ jobId: `${job.id}-${job.attempt}`, removeOnComplete: false, removeOnFail: false },
						);
				},
				{ connection: options.redis(), prefix: options.prefix, concurrency },
			);
			worker.on("error", (err) => logger.error({ err }, "worker error"));
			return () => worker.close();
		},
	};
}
