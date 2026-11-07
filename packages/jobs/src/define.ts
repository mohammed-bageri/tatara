import type { CoreLogger } from "@tatara/core";
import type { z } from "zod";

/** What every driver carries: the same fields whether the job sits in Redis, Postgres or Kafka. */
export interface JobEnvelope {
	id: string;
	topic: string;
	data: unknown;
	/** the org the job acts for; null for platform work */
	orgId: string | null;
	/** the request that enqueued the job, for tracing; absent on jobs enqueued before it existed */
	requestId?: string | null;
	/** 1 for the first run */
	attempt: number;
	maxAttempts: number;
	enqueuedAt: string;
}

export interface JobContext {
	logger: CoreLogger;
	jobId: string;
	attempt: number;
	orgId: string | null;
	requestId: string | null;
}

export interface ConsumerDefinition<T extends string = string, S extends z.ZodType = z.ZodType> {
	/** job name, e.g. "billing.invoice-paid" */
	topic: T;
	description: string;
	schema: S;
	/** runs before the job is dead (default 3) */
	attempts?: number;
	/** first retry delay; each later one doubles (default 1s, at most an hour) */
	backoffMs?: number;
	/** jobs must be idempotent: a retry runs `handle` again */
	handle(data: z.infer<S>, ctx: JobContext): Promise<void>;
	/** after the last attempt fails, or when the payload never validates; not on every failure */
	onDeadLetter?(data: unknown, ctx: JobContext & { error: unknown }): Promise<void>;
}

/** Default export of every `consumers/*.ts`; run by the worker app. */
export function defineConsumer<const T extends string, S extends z.ZodType>(
	definition: ConsumerDefinition<T, S>,
): ConsumerDefinition<T, S> {
	return definition;
}

/** topic → the payload `enqueue` takes, from the app's consumers. */
export type TopicsOf<C extends readonly ConsumerDefinition<string, z.ZodType>[]> = {
	[K in C[number] as K["topic"]]: z.input<K["schema"]>;
};

export interface ScheduleContext {
	logger: CoreLogger;
	/** runs `fn` once per org, each in its own try: one org failing doesn't stop the rest */
	forEachOrg(fn: (orgId: string) => Promise<void>): Promise<{ done: number; failed: string[] }>;
}

export interface ScheduleDefinition {
	name: string;
	/** cron expression (seconds optional), evaluated in UTC */
	cron: string;
	/** how long a tick stays claimed (default an hour): one run per tick across processes and triggers */
	lockTtlMs?: number;
	run(ctx: ScheduleContext): Promise<void>;
}

/** Default export of every `schedules/*.ts`; run by the cron app or an external trigger. */
export function defineSchedule(definition: ScheduleDefinition): ScheduleDefinition {
	return definition;
}

export class UnknownTopicError extends Error {}

export class InvalidPayloadError extends Error {}

/** The consumer's parsed payload, or an InvalidPayloadError saying why not. */
export function parsePayload(consumer: ConsumerDefinition, data: unknown): unknown {
	const parsed = consumer.schema.safeParse(data);
	if (!parsed.success)
		throw new InvalidPayloadError(`Invalid payload for ${consumer.topic}: ${parsed.error.message}`);
	return parsed.data;
}

/** Validates and runs one job without retries; for tests that call a consumer directly. */
export async function processJob(
	consumers: readonly ConsumerDefinition[],
	topic: string,
	data: unknown,
	ctx: Omit<JobContext, "orgId" | "requestId"> & {
		orgId?: string | null;
		requestId?: string | null;
	},
): Promise<void> {
	const consumer = consumers.find((c) => c.topic === topic);
	if (!consumer) throw new UnknownTopicError(`No consumer for topic "${topic}"`);
	await consumer.handle(parsePayload(consumer, data), {
		...ctx,
		orgId: ctx.orgId ?? null,
		requestId: ctx.requestId ?? null,
	});
}
