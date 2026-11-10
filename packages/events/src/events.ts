import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CoreLogger } from "@tatara/core";
import { z } from "zod";
import {
	defineEvent,
	type EmitInput,
	type EventDefinition,
	type EventNameValidator,
	type EventRecord,
	type Subscriber,
	SYSTEM_ACTOR,
} from "./define.ts";
import type { DeliveryClaim, EventStore, NewEvent } from "./store.ts";

/** The jobs topic the relay publishes event ids on; `events.consumer` handles it. */
export const EVENTS_TOPIC = "events.dispatch";

/** `lastError` of a delivery whose subscriber this process does not have. */
export const UNKNOWN_SUBSCRIBER_ERROR = "subscriber not loaded in this process";
/** `lastError` of a delivery the reconcile sweep created. */
export const MISSED_BY_DISPATCH = "missed by dispatch; created by the reconcile sweep";

const EMIT_CHUNK = 1000;

/** A relay publish that did not settle within `publishTimeoutMs`: the broker hangs, not refuses. */
export class PublishTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Event publish timed out after ${timeoutMs}ms`);
		this.name = "PublishTimeoutError";
	}
}

const dispatchSchema = z.object({ eventId: z.string().min(1) });

/** `events.consumer`'s type, for the app's `consumers/*.ts` file that default-exports it. */
export interface EventsConsumer {
	topic: typeof EVENTS_TOPIC;
	description: string;
	schema: typeof dispatchSchema;
	handle(data: z.output<typeof dispatchSchema>): Promise<void>;
}

/** Structurally a `@tatara/jobs` ScheduleDefinition. */
export interface EventsSchedule {
	name: string;
	description: string;
	cron: string;
	lockTtlMs?: number;
	run(): Promise<void>;
}

/** What the relay needs of `@tatara/jobs`' producer. */
export interface EventsJobs {
	enqueue(
		topic: never,
		data: never,
		options?: { orgId?: string | null; requestId?: string | null },
	): Promise<string>;
}

export interface EventsOptions<Executor, Defs extends readonly EventDefinition[]> {
	store: EventStore<Executor>;
	/** opens a transaction on the app's database; `events.transaction` needs it */
	transaction?: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T>;
	/** the app's definitions (`#generated/events`): lets `emit` take a name, and checks subscribers */
	events?: Defs;
	/** the app's subscribers (`#generated/subscribers`), or a loader for them */
	subscribers: readonly Subscriber[] | (() => Promise<readonly Subscriber[]>);
	/**
	 * The relay enqueues `{ eventId }` on `events.dispatch` and the worker dispatches it. Without
	 * jobs, the relay dispatches in its own process.
	 */
	jobs?: EventsJobs;
	logger: CoreLogger;
	/**
	 * Validates event names at registration and emit: a RegExp pattern or a function returning an
	 * error message (or undefined if valid). Default: two or more dot-separated lowercase segments.
	 */
	eventNamePattern?: RegExp | ((name: string) => string | undefined);
	/** bound on one relay publish (default 2.5s): a hung broker must not hold row locks */
	publishTimeoutMs?: number;
	/** after a publish times out, the post-commit fast path pauses this long (default 30s) */
	fastPathCooldownMs?: number;
	/** a delivery is dead after this many attempts (default 8) */
	maxAttempts?: number;
	/** delay before the next attempt after `attempts` failures (default min(2^n × 15s, 1h)) */
	backoffMs?: (attempts: number) => number;
	/** a `running` claim older than this belongs to a crashed runner and is retried (default 5 min) */
	staleClaimMs?: number;
	/** events the reconcile sweep looks back over (default 30 min) */
	reconcileLookbackMs?: number;
	/** events published more recently than this are still with dispatch (default 2 min) */
	reconcileGraceMs?: number;
	/** published events are pruned this many months after they occurred (default 13) */
	retentionMonths?: number;
	now?: () => Date;
}

type PayloadOf<D> = D extends EventDefinition<string, infer S> ? z.input<S> : never;

export interface Emit<Executor, Defs extends readonly EventDefinition[]> {
	<D extends EventDefinition>(
		executor: Executor,
		event: D,
		input: EmitInput<z.input<D["schema"]>>,
	): Promise<string>;
	<N extends Defs[number]["name"]>(
		executor: Executor,
		event: N,
		input: EmitInput<PayloadOf<Extract<Defs[number], { name: N }>>>,
	): Promise<string>;
}

export interface EmitMany<Executor, Defs extends readonly EventDefinition[]> {
	<D extends EventDefinition>(
		executor: Executor,
		event: D,
		inputs: readonly EmitInput<z.input<D["schema"]>>[],
	): Promise<string[]>;
	<N extends Defs[number]["name"]>(
		executor: Executor,
		event: N,
		inputs: readonly EmitInput<PayloadOf<Extract<Defs[number], { name: N }>>>[],
	): Promise<string[]>;
}

interface TxContext {
	ids: string[];
	hooks: Array<() => Promise<void>>;
}

function assertUnique<T>(items: readonly T[], key: (item: T) => string, label: string): void {
	const seen = new Set<string>();
	for (const item of items) {
		const k = key(item);
		if (seen.has(k)) throw new Error(`Duplicate ${label} "${k}"`);
		seen.add(k);
	}
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The app's events: `emit` in a transaction, `transaction` (publishes right after commit),
 * `afterCommit`, the relay, dispatch, the retry and reconcile sweeps, prune, and the consumer and
 * schedules that drive them.
 */
export function createEvents<
	Executor,
	const Defs extends readonly EventDefinition[] = readonly EventDefinition[],
>(options: EventsOptions<Executor, Defs>) {
	const { store, logger } = options;
	const now = options.now ?? (() => new Date());
	const publishTimeoutMs = options.publishTimeoutMs ?? 2_500;
	const fastPathCooldownMs = options.fastPathCooldownMs ?? 30_000;
	const maxAttempts = options.maxAttempts ?? 8;
	const backoffMs = options.backoffMs ?? ((n: number) => Math.min(2 ** n * 15_000, 3_600_000));
	const staleClaimMs = options.staleClaimMs ?? 5 * 60_000;
	const reconcileLookbackMs = options.reconcileLookbackMs ?? 30 * 60_000;
	const reconcileGraceMs = options.reconcileGraceMs ?? 2 * 60_000;
	const retentionMonths = options.retentionMonths ?? 13;
	const validator = options.eventNamePattern;

	const definitions = new Map<string, EventDefinition>();
	if (options.events) {
		assertUnique(options.events, (d) => d.name, "event name");
		for (const d of options.events) {
			// Validate each registered definition against the custom pattern
			defineEvent(d as never, validator);
			definitions.set(d.name, d);
		}
	}

	let loaded: Promise<readonly Subscriber[]> | undefined;
	function subscribers(): Promise<readonly Subscriber[]> {
		loaded ??= Promise.resolve(
			typeof options.subscribers === "function" ? options.subscribers() : options.subscribers,
		).then((subs) => {
			assertUnique(subs, (s) => s.name, "event subscriber");
			if (definitions.size > 0) {
				for (const s of subs)
					for (const name of s.events)
						if (!definitions.has(name))
							throw new Error(`Event subscriber "${s.name}" listens to unknown event "${name}"`);
			}
			return subs;
		});
		return loaded;
	}

	const context = new AsyncLocalStorage<TxContext>();

	function definitionOf(event: EventDefinition | string): EventDefinition {
		if (typeof event !== "string") {
			// For event definitions passed directly, validate them at emit time
			defineEvent(event as never, validator);
			return event;
		}
		const def = definitions.get(event);
		if (!def) throw new Error(`Unknown event "${event}"`);
		return def;
	}

	function row(def: EventDefinition, input: EmitInput<unknown>, at: Date): NewEvent {
		return {
			id: randomUUID(),
			name: def.name,
			version: def.version,
			orgId: input.orgId ?? null,
			aggregateType: def.aggregateType ?? null,
			aggregateId: input.aggregateId ?? null,
			actor: input.actor ?? SYSTEM_ACTOR,
			payload: def.schema.parse(input.payload),
			causationId: input.cause?.eventId ?? null,
			correlationId: input.cause ? (input.cause.correlationId ?? input.cause.eventId) : null,
			depth: input.cause ? input.cause.depth + 1 : 0,
			occurredAt: at,
		};
	}

	async function emitMany(
		executor: Executor,
		event: EventDefinition | string,
		inputs: readonly EmitInput<unknown>[],
	): Promise<string[]> {
		const def = definitionOf(event);
		const at = now();
		const rows = inputs.map((input) => row(def, input, at));
		for (let i = 0; i < rows.length; i += EMIT_CHUNK) {
			await store.insertEvents(executor, rows.slice(i, i + EMIT_CHUNK));
		}
		const ids = rows.map((r) => r.id);
		context.getStore()?.ids.push(...ids);
		return ids;
	}

	// Per process. While the broker hangs, every fast-path publish would hold a connection and its
	// row locks for the whole timeout; after one timeout the fast path pauses and the sweep goes on.
	let fastPathPausedUntil = 0;
	const fastPathEnabled = () => now().getTime() >= fastPathPausedUntil;

	async function withTimeout(fn: () => Promise<unknown>, timeoutMs: number): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new PublishTimeoutError(timeoutMs)), timeoutMs);
		});
		try {
			await Promise.race([fn(), timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	const enqueue = options.jobs?.enqueue.bind(options.jobs) as
		| ((
				topic: string,
				data: unknown,
				options?: { orgId?: string | null; requestId?: string | null },
		  ) => Promise<string>)
		| undefined;

	// without jobs there is no broker to hang, so only the enqueue is bounded
	function publishOne(event: { id: string; orgId: string | null }): Promise<unknown> {
		if (!enqueue) return dispatch(event.id);
		return withTimeout(
			() => enqueue(EVENTS_TOPIC, { eventId: event.id }, { orgId: event.orgId }),
			publishTimeoutMs,
		);
	}

	/**
	 * Lock, publish, mark: unpublished events go out in outbox order and the ones that made it are
	 * marked before the transaction commits. The batch stops at the first failure (the broker will
	 * most likely fail the rest too); the rest wait for the next sweep. An event can be published
	 * twice (a timed-out publish may still land), never lost; dispatch dedupes per subscriber.
	 */
	async function relay(input: { ids?: readonly string[]; limit?: number } = {}): Promise<number> {
		if (input.ids && input.ids.length === 0) return 0;
		const limit = input.limit ?? input.ids?.length ?? 200;
		return store.relayBatch({ ids: input.ids, limit, now: now() }, async (batch) => {
			const succeeded: string[] = [];
			for (const event of batch) {
				try {
					await publishOne(event);
					succeeded.push(event.id);
					fastPathPausedUntil = 0;
				} catch (err) {
					if (err instanceof PublishTimeoutError) {
						fastPathPausedUntil = now().getTime() + fastPathCooldownMs;
					}
					logger.warn(
						{ err, eventId: event.id, skipped: batch.length - succeeded.length - 1 },
						"event publish failed; stopping this batch, the sweep retries",
					);
					break;
				}
			}
			return succeeded;
		});
	}

	function publishAfterCommit(ids: string[]): void {
		if (!fastPathEnabled()) {
			logger.debug({ count: ids.length }, "post-commit publish paused; the relay sweep publishes");
			return;
		}
		void relay({ ids }).catch((err: unknown) =>
			logger.error({ err, count: ids.length }, "post-commit event publish failed"),
		);
	}

	async function transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
		const open = options.transaction;
		if (!open) throw new Error("createEvents needs `transaction` for events.transaction");
		const ctx: TxContext = { ids: [], hooks: [] };
		const result = await context.run(ctx, () => open(fn));
		if (ctx.ids.length > 0) publishAfterCommit(ctx.ids);
		for (const hook of ctx.hooks) {
			try {
				await hook();
			} catch (err) {
				logger.error({ err }, "post-commit hook failed");
			}
		}
		return result;
	}

	function afterCommit(hook: () => Promise<void>): boolean {
		const ctx = context.getStore();
		if (!ctx) return false;
		ctx.hooks.push(hook);
		return true;
	}

	async function recordFailure(
		claim: DeliveryClaim,
		attempts: number,
		at: { eventId: string; subscriber: string },
		reason: string,
		err?: unknown,
	): Promise<void> {
		const next = attempts + 1;
		const dead = next >= maxAttempts;
		logger[dead ? "error" : "warn"](
			{ err, ...at, attempts: next, reason },
			dead ? "event delivery dead-lettered" : "event delivery failed; will retry",
		);
		await store.settleDelivery(claim, {
			status: dead ? "dead" : "failed",
			attempts: next,
			lastError: reason,
			nextAttemptAt: new Date(now().getTime() + backoffMs(next)),
		});
	}

	/** Runs one subscriber for one event and records the outcome. Never throws. */
	async function runDelivery(
		claim: DeliveryClaim,
		attempts: number,
		sub: Subscriber,
		event: EventRecord,
	): Promise<void> {
		try {
			await sub.handle(event, {
				logger: logger.child({ subscriber: sub.name, eventId: event.id }),
				attempt: attempts + 1,
			});
			await store.settleDelivery(claim, {
				status: "done",
				attempts: attempts + 1,
				lastError: null,
				completedAt: now(),
			});
		} catch (err) {
			await recordFailure(
				claim,
				attempts,
				{ eventId: event.id, subscriber: sub.name },
				message(err),
				err,
			);
		}
	}

	/**
	 * Runs every subscriber of the event once: each gets its own delivery, created as it is
	 * claimed, so a redelivered event runs nobody twice. Failures are retried by the retry sweep.
	 */
	async function dispatch(eventId: string): Promise<void> {
		const event = await store.findEvent(eventId);
		if (!event) {
			logger.warn({ eventId }, "event not found for dispatch (pruned or rolled back)");
			return;
		}
		for (const sub of await subscribers()) {
			if (!sub.events.includes(event.name)) continue;
			const token = randomUUID();
			const id = await store.claimNewDelivery({
				eventId,
				subscriber: sub.name,
				token,
				now: now(),
			});
			if (!id) continue;
			await runDelivery({ id, token }, 0, sub, event);
		}
	}

	const due = () => {
		const at = now();
		return { now: at, staleBefore: new Date(at.getTime() - staleClaimMs) };
	};

	/** Runs due failed deliveries and the ones crashed runners left; returns how many it claimed. */
	async function retry(input: { limit?: number } = {}): Promise<number> {
		const byName = new Map((await subscribers()).map((s) => [s.name, s]));
		const ids = await store.dueDeliveries({ ...due(), limit: input.limit ?? 100 });
		let ran = 0;
		for (const id of ids) {
			// claimed right before it runs: a batch that outlives the sweep interval keeps its later
			// rows claimable by the next sweep instead of handing them to both
			const token = randomUUID();
			const delivery = await store.claimDueDelivery({ ...due(), id, token });
			if (!delivery) continue;
			ran++;
			const claim = { id, token };
			const event = await store.findEvent(delivery.eventId);
			if (!event) {
				await store.settleDelivery(claim, {
					status: "dead",
					attempts: delivery.attempts,
					lastError: "event missing",
				});
				continue;
			}
			const sub = byName.get(delivery.subscriber);
			if (!sub) {
				// a newer process created it, or the subscriber was removed: back off like a failure,
				// so a process that has it runs it, and a removed one goes dead after maxAttempts
				await recordFailure(
					claim,
					delivery.attempts,
					{ eventId: delivery.eventId, subscriber: delivery.subscriber },
					UNKNOWN_SUBSCRIBER_ERROR,
				);
				continue;
			}
			await runDelivery(claim, delivery.attempts, sub, event);
		}
		return ran;
	}

	/**
	 * A dispatcher only creates deliveries for the subscribers it has, so in a rolling deploy an
	 * old worker skips a new subscriber. Creates the missing deliveries of recent published events,
	 * due now, for the retry sweep. A new subscriber can so receive events from up to
	 * `reconcileLookbackMs` before its deploy.
	 */
	async function reconcile(input: { limit?: number } = {}): Promise<number> {
		const at = now();
		let created = 0;
		for (const sub of await subscribers()) {
			const missing = await store.missingDeliveries({
				subscriber: sub.name,
				names: sub.events,
				occurredSince: new Date(at.getTime() - reconcileLookbackMs),
				publishedBefore: new Date(at.getTime() - reconcileGraceMs),
				limit: input.limit ?? 500,
			});
			if (missing.length === 0) continue;
			const count = await store.createDeliveries(
				missing.map((eventId) => ({
					eventId,
					subscriber: sub.name,
					nextAttemptAt: at,
					lastError: MISSED_BY_DISPATCH,
				})),
			);
			created += count;
			logger.warn({ subscriber: sub.name, created: count }, "created deliveries dispatch skipped");
		}
		return created;
	}

	/** Deletes published events past the retention, with their deliveries; never unpublished ones. */
	async function prune(): Promise<number> {
		const cutoff = now();
		cutoff.setUTCMonth(cutoff.getUTCMonth() - retentionMonths);
		return store.prune({ occurredBefore: cutoff });
	}

	/** Makes dead deliveries due again (after fixing the handler); attempts are kept. */
	function requeueDead(filter: { subscriber?: string; eventId?: string } = {}): Promise<number> {
		return store.requeueDead({ ...filter, now: now() });
	}

	const consumer: EventsConsumer = {
		topic: EVENTS_TOPIC,
		description: "Run an event's subscribers",
		schema: dispatchSchema,
		handle: ({ eventId }) => dispatch(eventId),
	};

	const sweep = (what: string, fn: () => Promise<number>) => async () => {
		const count = await fn();
		if (count > 0) logger.info({ count }, what);
	};

	const schedules = {
		relay: {
			name: "events-relay",
			description: "Publish events the post-commit fast path missed",
			cron: "*/5 * * * * *",
			lockTtlMs: 4_000,
			run: sweep("relayed events", () => relay()),
		},
		retry: {
			name: "events-retry",
			description: "Retry failed event deliveries that are due",
			cron: "*/30 * * * * *",
			lockTtlMs: 25_000,
			run: sweep("retried event deliveries", () => retry()),
		},
		reconcile: {
			name: "events-reconcile",
			description: "Create deliveries a dispatcher skipped because it did not know a subscriber",
			cron: "45 * * * * *",
			lockTtlMs: 50_000,
			run: sweep("reconciled event deliveries", () => reconcile()),
		},
		prune: {
			name: "events-prune",
			description: `Delete published events past the ${retentionMonths}-month retention`,
			cron: "15 3 * * *",
			run: sweep("pruned events", () => prune()),
		},
	} satisfies Record<string, EventsSchedule>;

	return {
		emit: ((executor: Executor, event: EventDefinition | string, input: EmitInput<unknown>) =>
			emitMany(executor, event, [input]).then((ids) => ids[0] as string)) as Emit<Executor, Defs>,
		emitMany: emitMany as EmitMany<Executor, Defs>,
		transaction,
		afterCommit,
		relay,
		dispatch,
		retry,
		reconcile,
		prune,
		requeueDead,
		fastPathEnabled,
		subscribers,
		definition: (name: string) => definitions.get(name),
		consumer,
		schedules,
	};
}
