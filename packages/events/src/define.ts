import type { CoreLogger } from "@tatara/core";
import type { z } from "zod";

/** Who caused a change: `{ type: "user", id }`, `{ type: "system", reason? }`, or an app's own kind. */
export interface EventActor {
	type: string;
	id?: string;
	reason?: string;
}

export const SYSTEM_ACTOR: EventActor = { type: "system" };

export interface EventDefinition<N extends string = string, S extends z.ZodType = z.ZodType> {
	/** dotted lowercase, e.g. "billing.invoice.paid"; unique across the app */
	name: N;
	/** bump it for a breaking payload change; stored with each event (default 1) */
	version: number;
	/** validated at emit time; keep secrets and free text out of it */
	schema: S;
	/** what the event is about, e.g. "invoice"; stored with each event */
	aggregateType?: string;
	description?: string;
	/** how a UI names the event (an i18n key, or text): activity feeds, automation triggers */
	label?: string;
}

/** A stored event, as a subscriber receives it. */
export interface EventRecord<P = unknown, N extends string = string> {
	id: string;
	name: N;
	version: number;
	orgId: string | null;
	aggregateType: string | null;
	aggregateId: string | null;
	actor: EventActor;
	payload: P;
	/** the first event of a causal chain; null for a chain's first event */
	correlationId: string | null;
	/** the event that caused this one */
	causationId: string | null;
	/** 0 for a change nobody's event caused; cause depth + 1 otherwise */
	depth: number;
	occurredAt: Date;
}

/** The cause half of an emit, for writers that pass it through. */
export interface EmitCause {
	eventId: string;
	correlationId: string | null;
	depth: number;
}

/** Builds the cause for events emitted in reaction to `event`. */
export function causedBy(event: Pick<EventRecord, "id" | "correlationId" | "depth">): EmitCause {
	return { eventId: event.id, correlationId: event.correlationId, depth: event.depth };
}

export interface EmitInput<P> {
	payload: P;
	orgId?: string | null;
	aggregateId?: string | null;
	/** default `{ type: "system" }` */
	actor?: EventActor;
	/** set when this change was caused by another event */
	cause?: EmitCause;
}

export interface SubscriberContext {
	logger: CoreLogger;
	/** 1 for the first run of this delivery */
	attempt: number;
}

/** A subscriber as the dispatcher runs it. */
export interface Subscriber {
	/** unique across the app; stored on each delivery, so renaming it starts fresh deliveries */
	name: string;
	/** the event names it receives */
	events: readonly string[];
	description?: string;
	/** must be idempotent per `event.id`: delivery is at-least-once */
	handle(event: EventRecord, ctx: SubscriberContext): Promise<void>;
}

type EventRef = EventDefinition | string;
type RecordOf<R> =
	R extends EventDefinition<infer N, infer S> ? EventRecord<z.output<S>, N> : EventRecord;
type RecordsOf<E> = E extends readonly (infer R)[] ? RecordOf<R> : RecordOf<E>;

const NAME = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

/** Validates event names: a RegExp or a function returning an error message (or undefined if valid). */
export type EventNameValidator = RegExp | ((name: string) => string | undefined);

/** Default export of every `events/*.ts` (alone or in an array). */
export function defineEvent<
	const D extends Omit<EventDefinition, "version"> & { version?: number },
>(definition: D, validator?: EventNameValidator): Omit<D, "version"> & { version: number } {
	const pattern = validator instanceof RegExp ? validator : undefined;
	const check = typeof validator === "function" ? validator : undefined;

	if (pattern && !pattern.test(definition.name)) {
		throw new Error(
			`Event name "${definition.name}" does not match the required pattern ${pattern}`,
		);
	} else if (check) {
		const error = check(definition.name);
		if (error !== undefined) {
			throw new Error(`Event name "${definition.name}" failed validation: ${error}`);
		}
	} else if (!validator && !NAME.test(definition.name)) {
		throw new Error(
			`Event name "${definition.name}" must be dotted lowercase, e.g. "billing.invoice.paid"`,
		);
	}

	const version = definition.version ?? 1;
	if (!Number.isInteger(version) || version < 1) {
		throw new Error(`Event "${definition.name}" version must be a positive integer`);
	}
	return { ...definition, version };
}

/**
 * Default export of every `event-subscribers/*.ts`. `event` is one event or several (definitions
 * or names); with definitions, `handle` gets their typed payloads.
 */
export function defineSubscriber<const E extends EventRef | readonly EventRef[]>(subscriber: {
	name: string;
	event: E;
	description?: string;
	handle(event: RecordsOf<E>, ctx: SubscriberContext): Promise<void>;
}): Subscriber {
	const refs = (
		Array.isArray(subscriber.event) ? subscriber.event : [subscriber.event]
	) as EventRef[];
	const events = [...new Set(refs.map((r) => (typeof r === "string" ? r : r.name)))];
	if (events.length === 0) {
		throw new Error(`Event subscriber "${subscriber.name}" must list at least one event`);
	}
	return {
		name: subscriber.name,
		events,
		...(subscriber.description ? { description: subscriber.description } : {}),
		handle: subscriber.handle as Subscriber["handle"],
	};
}

/** event name → the payload `emit` takes, from the app's event definitions. */
export type EventPayloadsOf<D extends readonly EventDefinition[]> = {
	[K in D[number] as K["name"]]: z.input<K["schema"]>;
};
