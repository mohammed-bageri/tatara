import { randomUUID } from "node:crypto";
import type { z } from "zod";

/** Who a socket is: fixed when it connects, from its ticket. */
export interface SocketIdentity {
	userId: string;
	orgId: string;
	/** the auth session the ticket was issued for, for logs and audit */
	sessionId?: string;
}

/** The `{param}` names of a pattern as required string keys; `unknown` (so `{}`) with none. */
export type ChannelParams<P extends string> = P extends `${string}{${infer K}}${infer Rest}`
	? { [key in K]: string } & ChannelParams<Rest>
	: unknown;

export interface ChannelDefinition<
	P extends string = string,
	E extends Record<string, z.ZodType> = Record<string, z.ZodType>,
> {
	/** a dotted pattern with {params}, e.g. "survey.{surveyId}" */
	name: P;
	description: string;
	/** the events published on it, each with its payload schema */
	events: E;
	/** a permission the subscriber must hold, checked by `RealtimeOptions.checkPermission` */
	permission?: string;
	/** a feature the org's plan must include, checked by `RealtimeOptions.featureAllowed` */
	feature?: string;
	/** may this socket listen? (row-level checks: is the user in this survey's org team…) */
	authorize?(
		who: SocketIdentity,
		params: ChannelParams<P> & Record<string, string>,
	): Promise<boolean> | boolean;
}

/** Default export of every `channels/*.ts`. */
export function defineChannel<const P extends string, E extends Record<string, z.ZodType>>(
	definition: ChannelDefinition<P, E>,
): ChannelDefinition<P, E> {
	return definition;
}

const PARAM = "[A-Za-z0-9_-]{1,128}";
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const PARAM_SEGMENT = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/;

/** The params when `channel` matches `pattern`, else null. Params can't hold "." or "|". */
export function matchChannel(pattern: string, channel: string): Record<string, string> | null {
	const names: string[] = [];
	const source = pattern
		.split(/(\{[A-Za-z][A-Za-z0-9_]*\})/)
		.map((part) => {
			const param = /^\{(.+)\}$/.exec(part);
			if (!param) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			names.push(param[1] as string);
			return `(${PARAM})`;
		})
		.join("");
	const match = new RegExp(`^${source}$`).exec(channel);
	if (!match) return null;
	return Object.fromEntries(names.map((name, i) => [name, match[i + 1] as string]));
}

/** "survey.{surveyId}" with { surveyId: "s1" } → "survey.s1"; throws on a param it can't carry. */
export function channelName(pattern: string, params: Record<string, string>): string {
	return pattern.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, key: string) => {
		const value = params[key];
		if (value === undefined || !new RegExp(`^${PARAM}$`).test(value))
			throw new Error(`Channel ${pattern} needs a valid "${key}"`);
		return value;
	});
}

/** The built-in channels every socket joins; no module channel may start with these. */
export const ORG_CHANNEL = "org";
export const USER_CHANNEL = "user";
export const userChannel = (userId: string) => `${USER_CHANNEL}:${userId}`;

/**
 * Throws on channels the gateway can't route: a malformed or reserved name, a name declared twice,
 * a channel without events. Runs at attach, so a bad channel fails the boot.
 */
export function validateChannels(
	// biome-ignore lint/suspicious/noExplicitAny: channels with any params and events
	channels: readonly ChannelDefinition<string, any>[],
): void {
	const seen = new Set<string>();
	for (const channel of channels) {
		const name = channel.name;
		if (typeof name !== "string" || name.length === 0)
			throw new Error("A realtime channel needs a non-empty name");
		const params = new Set<string>();
		const segments = name.split(".");
		for (const segment of segments) {
			const param = PARAM_SEGMENT.exec(segment)?.[1];
			if (param) {
				if (params.has(param)) throw new Error(`Channel "${name}" declares {${param}} twice`);
				params.add(param);
			} else if (!SEGMENT.test(segment))
				throw new Error(
					`Channel "${name}" has an invalid segment "${segment}": use [A-Za-z0-9_-] or a whole {param}`,
				);
		}
		const first = segments[0] as string;
		if (first === ORG_CHANNEL || first === USER_CHANNEL)
			throw new Error(`Channel "${name}" uses the reserved name "${first}" (a built-in channel)`);
		if (seen.has(name)) throw new Error(`Channel "${name}" is declared twice`);
		seen.add(name);
		if (!channel.events || Object.keys(channel.events).length === 0)
			throw new Error(`Channel "${name}" needs at least one event`);
		if (channel.authorize !== undefined && typeof channel.authorize !== "function")
			throw new Error(`Channel "${name}": authorize must be a function`);
	}
}

/** Bump only on a breaking wire change; clients drop envelopes of another version. */
export const ENVELOPE_VERSION = 1;
/** Every event reaches clients on this one socket.io event, as a {@link RealtimeEnvelope}. */
export const WIRE_EVENT = "rt";
/** Sent just before the server closes a socket, with `{ reason }`. */
export const WIRE_CLOSED_EVENT = "rt:closed";

export interface RealtimeEnvelope<T = unknown> {
	/** unique per publish: clients dedupe on it across a reconnect */
	id: string;
	v: typeof ENVELOPE_VERSION;
	/** the concrete channel: "org", "user:<userId>", or a module channel with its params bound */
	ch: string;
	ev: string;
	/** epoch millis, server clock */
	ts: number;
	data: T;
}

export function createEnvelope<T>(ch: string, ev: string, data: T): RealtimeEnvelope<T> {
	return { id: randomUUID(), v: ENVELOPE_VERSION, ch, ev, ts: Date.now(), data };
}

/** Why a subscribe was refused; CHANNEL_UNKNOWN and CHANNEL_INVALID won't change on a retry. */
export type DenyCode =
	| "CHANNEL_UNKNOWN"
	| "CHANNEL_INVALID"
	| "ENTITLEMENT_DENIED"
	| "PERMISSION_DENIED"
	| "TOO_MANY_SUBSCRIPTIONS"
	| "FORBIDDEN";

/** The ack of a `subscribe` or `unsubscribe`. */
export interface SubscribeAck {
	ok: boolean;
	channel: string;
	code?: DenyCode;
}

/** Sent in `rt:closed`; an app may add reasons of its own. */
export type DisconnectReason =
	| "session_invalid"
	| "logged_out"
	| "tenant_suspended"
	| "tenant_deleted"
	| "permissions_changed"
	| "impersonation_ended"
	| (string & {});

// every room starts with the org, so a channel can never reach another tenant
export const userRoom = (who: SocketIdentity) => `o:${who.orgId}|user:${who.userId}`;
export const orgRoom = (orgId: string) => `o:${orgId}|org`;
// the pattern is part of the room: a name two patterns both match stays two rooms
export const channelRoom = (orgId: string, pattern: string, channel: string) =>
	`o:${orgId}|ch:${pattern}|${channel}`;
