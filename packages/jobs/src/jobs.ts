import { randomUUID } from "node:crypto";
import {
	type ConsumerDefinition,
	type JobEnvelope,
	parsePayload,
	UnknownTopicError,
} from "./define.ts";
import type { JobDriver } from "./driver.ts";

export interface EnqueueOptions {
	/** the org the job acts for (default: none, platform work) */
	orgId?: string | null;
	/** the request enqueuing it: the job's logs and context carry it */
	requestId?: string | null;
	/** wait this long before the first run */
	delayMs?: number;
	/** the caller's transaction: with the Postgres driver the job commits (or not) with it */
	executor?: unknown;
}

const DEFAULT_ATTEMPTS = 3;

/**
 * Build a Map from consumers, rejecting duplicates. Two consumers registered for the same topic
 * is a bug: Sana's model is one event to many subscribers on top of jobs, so a duplicate
 * consumer per topic means one is silently dropped.
 */
function buildConsumerMap(
	consumers: readonly ConsumerDefinition[],
): Map<string, ConsumerDefinition> {
	const byTopic = new Map<string, ConsumerDefinition>();
	for (const consumer of consumers) {
		const existing = byTopic.get(consumer.topic);
		if (existing) {
			throw new Error(
				`Duplicate consumers for topic "${consumer.topic}": "${existing.description}" and "${consumer.description}"`,
			);
		}
		byTopic.set(consumer.topic, consumer);
	}
	return byTopic;
}

/**
 * The app's job producer. `Topics` (topic → payload, `TopicsOf<typeof consumers>`) types it; pass
 * `consumers` too and a payload they would reject throws here instead of in the worker.
 */
export function createJobs<Topics extends object = Record<string, unknown>>(options: {
	driver: JobDriver;
	// biome-ignore lint/suspicious/noExplicitAny: any consumer, whatever its payload type
	consumers?: readonly ConsumerDefinition<string, any>[];
}) {
	const byTopic = options.consumers ? buildConsumerMap(options.consumers) : undefined;
	return {
		driver: options.driver,
		/** Stores a job for the consumer with this topic. Consumers validate it again when it runs. */
		async enqueue<T extends keyof Topics & string>(
			topic: T,
			data: Topics[T],
			opts: EnqueueOptions = {},
		): Promise<string> {
			const consumer = byTopic?.get(topic);
			if (byTopic && !consumer) throw new UnknownTopicError(`No consumer for topic "${topic}"`);
			if (consumer) parsePayload(consumer, data);
			const job: JobEnvelope = {
				id: randomUUID(),
				topic,
				data,
				orgId: opts.orgId ?? null,
				...(opts.requestId ? { requestId: opts.requestId } : {}),
				attempt: 1,
				maxAttempts: consumer?.attempts ?? DEFAULT_ATTEMPTS,
				enqueuedAt: new Date().toISOString(),
			};
			await options.driver.send([{ job, delayMs: opts.delayMs ?? 0 }], opts.executor);
			return job.id;
		},
	};
}
