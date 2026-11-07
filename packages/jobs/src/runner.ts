import type { CoreLogger } from "@tatara/core";
import {
	type ConsumerDefinition,
	type InvalidPayloadError,
	type JobEnvelope,
	parsePayload,
	UnknownTopicError,
} from "./define.ts";

export type Outcome =
	| { status: "done" }
	| { status: "retry"; delayMs: number; error: unknown }
	| { status: "dead"; error: unknown };

const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Doubles from `baseMs` per attempt, capped at an hour. */
export function backoffDelay(baseMs: number, attempt: number): number {
	return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, attempt - 1));
}

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

/** Where a driver takes a job from, and what it hands back to the store. */
export type JobHandler = (job: JobEnvelope) => Promise<Outcome>;

/**
 * Runs one delivery of a job and says what the driver should do next. Every driver uses this, so
 * validation, retries and the dead-letter hook behave the same on Redis, Postgres and Kafka.
 */
export function jobHandler(
	consumers: readonly ConsumerDefinition[],
	logger: CoreLogger,
): JobHandler {
	const byTopic = buildConsumerMap(consumers);
	return async (job) => {
		const requestId = job.requestId ?? null;
		const log = logger.child({
			jobId: job.id,
			topic: job.topic,
			attempt: job.attempt,
			...(requestId ? { requestId } : {}),
		});
		const ctx = { logger: log, jobId: job.id, attempt: job.attempt, orgId: job.orgId, requestId };
		const consumer = byTopic.get(job.topic);
		const dead = async (error: unknown): Promise<Outcome> => {
			log.error({ err: error }, "job dead");
			try {
				await consumer?.onDeadLetter?.(job.data, { ...ctx, error });
			} catch (hookError) {
				log.error({ err: hookError }, "onDeadLetter failed");
			}
			return { status: "dead", error };
		};
		if (!consumer) return dead(new UnknownTopicError(`No consumer for topic "${job.topic}"`));
		// redelivered past its attempts: the worker died during each one, so stop trying
		if (job.attempt > (consumer.attempts ?? job.maxAttempts))
			return dead(new Error(`Job ${job.id} was lost by its worker on every attempt`));
		let data: unknown;
		try {
			data = parsePayload(consumer, job.data);
		} catch (error) {
			// a payload that doesn't validate never will: no retries
			return dead(error as InvalidPayloadError);
		}
		try {
			await consumer.handle(data as never, ctx);
			return { status: "done" };
		} catch (error) {
			// the consumer's own setting wins: a producer may not have known it
			if (job.attempt >= (consumer.attempts ?? job.maxAttempts)) return dead(error);
			const delayMs = backoffDelay(consumer.backoffMs ?? 1000, job.attempt);
			log.warn({ err: error, delayMs }, "job failed, retrying");
			return { status: "retry", delayMs, error };
		}
	};
}
