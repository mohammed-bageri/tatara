import { randomBytes } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { type CoreLogger, onShutdown } from "@tatara/core";
import type { Redis } from "ioredis";
import { Server } from "socket.io";
import type { z } from "zod";
import {
	type ChannelDefinition,
	type ChannelParams,
	channelName,
	channelRoom,
	createEnvelope,
	type DenyCode,
	type DisconnectReason,
	matchChannel,
	ORG_CHANNEL,
	orgRoom,
	type SocketIdentity,
	type SubscribeAck,
	userChannel,
	userRoom,
	validateChannels,
	WIRE_CLOSED_EVENT,
	WIRE_EVENT,
} from "./channels.ts";

/** Where tickets live: `cache` from `@tatara/cache` is one (its add and take). */
export interface TicketStore {
	add(key: string, value: SocketIdentity, options: { ttlMs: number }): Promise<boolean>;
	take(key: string): Promise<SocketIdentity | null>;
}

export interface RealtimeOptions {
	/** "noop" turns every publish into nothing and attach into a no-op (tests, apps without sockets) */
	driver: "socketio" | "noop";
	/** "redis" shares rooms across api processes and lets other processes publish */
	adapter: { kind: "memory" } | { kind: "redis"; redis: () => Redis };
	tickets: TicketStore;
	ticketTtlMs?: number;
	path?: string;
	/** the same check the HTTP app's CORS makes (corsOrigin from @tatara/http) */
	allowOrigin(origin: string): boolean;
	maxSubscriptionsPerSocket?: number;
	/**
	 * How long a socket lives before the server closes it (default 15 min ±10%, 0: forever). The
	 * client gets `rt:closed { reason: "session_invalid" }` and reconnects with a new ticket, so a
	 * user who lost access is checked again.
	 */
	maxSocketLifetimeMs?: number;
	/** Longest a publish waits for the adapter before giving up and logging (default 1000 ms). */
	publishTimeoutMs?: number;
	/** Checks a channel's `permission` on subscribe; required when a channel declares one. */
	checkPermission?(who: SocketIdentity, permission: string): Promise<boolean> | boolean;
	/** Checks a channel's `feature` against the org's plan; required when a channel declares one. */
	featureAllowed?(orgId: string, feature: string): Promise<boolean> | boolean;
	logger: CoreLogger;
}

type Emitter = {
	to(room: string): { emit(event: string, payload: unknown): unknown };
	in(room: string): { disconnectSockets(close?: boolean): unknown };
};

const NOOP: Emitter = {
	to: () => ({ emit: () => true }),
	in: () => ({ disconnectSockets: () => undefined }),
};

type Target = { emitter: Emitter; flush: () => Promise<unknown> };

/**
 * The emitter publishes and drops the promise: wrapped, a failed publish can't become an unhandled
 * rejection (the PING after it reports the failure instead).
 */
function quietPublish(client: Redis): Redis {
	return new Proxy(client, {
		get(target, key, receiver) {
			if (key === "publish")
				return (...args: Parameters<Redis["publish"]>) => {
					const sent = target.publish(...args);
					sent.catch(() => {});
					return sent;
				};
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

// biome-ignore lint/suspicious/noExplicitAny: channels with any params and events
type AnyChannel = ChannelDefinition<string, any>;

/** The app's realtime: attach it to the api server; publish from anywhere. */
export function createRealtime(options: RealtimeOptions) {
	const ttlMs = options.ticketTtlMs ?? 60_000;
	const log = options.logger;
	let io: Server | undefined;
	let emitter: Promise<Target> | undefined;
	let channels: readonly AnyChannel[] = [];

	const done = async () => {};
	/** where a publish goes: the attached server, else Redis (other processes), else nowhere */
	const target = (): Promise<Target> => {
		if (options.driver === "noop") return Promise.resolve({ emitter: NOOP, flush: done });
		if (io) return Promise.resolve({ emitter: io as unknown as Emitter, flush: done });
		const adapter = options.adapter;
		if (adapter.kind !== "redis") return Promise.resolve({ emitter: NOOP, flush: done });
		emitter ??= import("@socket.io/redis-emitter").then(({ Emitter }) => {
			const client = adapter.redis();
			onShutdown("realtime-emitter", async () => {
				await client.quit().catch(() => client.disconnect());
			});
			// the emitter publishes without waiting; a PING on the same connection answers only after
			// what came before it went out, so a process may exit once a publish resolves
			return {
				emitter: new Emitter(quietPublish(client)) as unknown as Emitter,
				flush: () => client.ping(),
			};
		});
		return emitter;
	};
	const publishTimeoutMs = options.publishTimeoutMs ?? 1000;
	// Bound a wait; the timer is cleared either way so publishes leave nothing behind.
	const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("publish flush timeout")), timeoutMs);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	};
	// never throws: a realtime failure must not fail the work that published
	const send = async (fn: (emitter: Emitter) => unknown, context: Record<string, unknown>) => {
		let flush: Target["flush"];
		try {
			const t = await target();
			fn(t.emitter);
			flush = t.flush;
		} catch (err) {
			log.error({ err, ...context }, "realtime publish failed");
			return;
		}
		try {
			await withTimeout(flush(), publishTimeoutMs);
		} catch (err) {
			log.warn({ err, ...context }, "realtime publish flush failed");
		}
	};
	const publish = (orgId: string, room: string, ch: string, ev: string, data: unknown) =>
		send((e) => e.to(room).emit(WIRE_EVENT, createEnvelope(ch, ev, data)), {
			orgId,
			channel: ch,
			event: ev,
		});
	const disconnect = (orgId: string, room: string, reason: DisconnectReason) =>
		send(
			(e) => {
				e.to(room).emit(WIRE_CLOSED_EVENT, { reason });
				e.in(room).disconnectSockets(true);
			},
			{ orgId, reason },
		);

	async function issueTicket(
		who: SocketIdentity,
	): Promise<{ ticket: string; expiresInMs: number }> {
		const ticket = `rt_${randomBytes(24).toString("base64url")}`;
		await options.tickets.add(`realtime:ticket:${ticket}`, who, { ttlMs });
		return { ticket, expiresInMs: ttlMs };
	}

	async function redeem(ticket: unknown): Promise<SocketIdentity | null> {
		if (typeof ticket !== "string" || !ticket.startsWith("rt_")) return null;
		let who: Partial<SocketIdentity> | null;
		try {
			who = await options.tickets.take(`realtime:ticket:${ticket}`);
		} catch (err) {
			log.error({ err }, "realtime ticket lookup failed, refusing the socket");
			return null;
		}
		if (!who) return null;
		if (!who.userId || !who.orgId) {
			log.error("realtime ticket has no userId or orgId, refusing the socket");
			return null;
		}
		return who as SocketIdentity;
	}

	type Decision = { ok: true; room: string } | { ok: false; code: DenyCode };

	/** feature, then permission, then the channel's own check; an error denies */
	async function authorizeSubscribe(who: SocketIdentity, name: string): Promise<Decision> {
		let definition: AnyChannel | undefined;
		let params: Record<string, string> | null = null;
		for (const d of channels) {
			params = matchChannel(d.name, name);
			if (params) {
				definition = d;
				break;
			}
		}
		if (!definition || !params) return { ok: false, code: "CHANNEL_UNKNOWN" };
		try {
			if (
				definition.feature !== undefined &&
				!(await options.featureAllowed?.(who.orgId, definition.feature))
			)
				return { ok: false, code: "ENTITLEMENT_DENIED" };
			if (
				definition.permission !== undefined &&
				!(await options.checkPermission?.(who, definition.permission))
			)
				return { ok: false, code: "PERMISSION_DENIED" };
			if (definition.authorize && !(await definition.authorize(who, params)))
				return { ok: false, code: "FORBIDDEN" };
		} catch (err) {
			log.error(
				{ err, channel: name, userId: who.userId, orgId: who.orgId },
				"realtime subscribe check failed, denying",
			);
			return { ok: false, code: "FORBIDDEN" };
		}
		return { ok: true, room: channelRoom(who.orgId, definition.name, name) };
	}

	const allowed = (origin: string | undefined) => !origin || options.allowOrigin(origin);

	async function attach(
		server: HttpServer,
		opts: { channels?: readonly AnyChannel[] } = {},
	): Promise<void> {
		if (options.driver === "noop") return;
		const list = opts.channels ?? [];
		validateChannels(list);
		for (const channel of list) {
			if (channel.permission !== undefined && !options.checkPermission)
				throw new Error(`Channel "${channel.name}" has a permission but no checkPermission is set`);
			if (channel.feature !== undefined && !options.featureAllowed)
				throw new Error(`Channel "${channel.name}" has a feature but no featureAllowed is set`);
		}
		channels = list;
		// everything that can fail or wait happens before the server listens for sockets: no socket
		// ever connects past the ticket check
		const adapter =
			options.adapter.kind === "redis"
				? await (async (redis) => {
						const { createAdapter } = await import("@socket.io/redis-adapter");
						const pub = redis();
						const sub = pub.duplicate();
						onShutdown("realtime-redis", async () => {
							await Promise.all([pub.quit(), sub.quit()]).catch(() => {});
						});
						return createAdapter(pub, sub);
					})(options.adapter.redis)
				: undefined;
		const server_ = new Server(server, {
			path: options.path ?? "/realtime",
			transports: ["websocket"],
			// browsers send Origin on the upgrade; CORS headers alone wouldn't stop it
			allowRequest: (req, cb) => cb(null, allowed(req.headers.origin)),
			cors: { origin: (origin, cb) => cb(null, allowed(origin)), credentials: true },
			...(adapter ? { adapter } : {}),
		});
		server_.use(async (socket, next) => {
			const who = await redeem((socket.handshake.auth as { ticket?: unknown } | undefined)?.ticket);
			if (!who) return next(new Error("unauthorized"));
			socket.data.who = who;
			next();
		});
		const maxSubscriptions = options.maxSubscriptionsPerSocket ?? 50;
		const lifetimeMs = options.maxSocketLifetimeMs ?? 15 * 60 * 1000;
		server_.on("connection", (socket) => {
			const who = socket.data.who as SocketIdentity;
			void socket.join([userRoom(who), orgRoom(who.orgId)]);
			if (lifetimeMs > 0) {
				// jittered so the sockets opened during a deploy don't all reconnect in one burst
				const jittered = lifetimeMs * (1 + 0.1 * (Math.random() * 2 - 1));
				const expire = setTimeout(() => {
					socket.emit(WIRE_CLOSED_EVENT, { reason: "session_invalid" });
					socket.disconnect(true);
				}, jittered);
				socket.on("disconnect", () => clearTimeout(expire));
			}
			const joined = new Map<string, string>();
			// subscriptions being authorized count toward the cap, so a burst can't pass it
			let pending = 0;
			socket.on("subscribe", async (channel: unknown, ack?: (r: SubscribeAck) => void) => {
				const reply = typeof ack === "function" ? ack : () => {};
				const name = typeof channel === "string" ? channel : "";
				if (!name) return reply({ ok: false, channel: "", code: "CHANNEL_INVALID" });
				if (joined.has(name)) return reply({ ok: true, channel: name });
				if (joined.size + pending >= maxSubscriptions)
					return reply({ ok: false, channel: name, code: "TOO_MANY_SUBSCRIPTIONS" });
				pending++;
				let decision: Decision;
				try {
					decision = await authorizeSubscribe(who, name);
				} finally {
					pending--;
				}
				if (!decision.ok) return reply({ ok: false, channel: name, code: decision.code });
				if (!socket.connected) return;
				if (!joined.has(name)) {
					joined.set(name, decision.room);
					await socket.join(decision.room);
				}
				reply({ ok: true, channel: name });
			});
			socket.on("unsubscribe", async (channel: unknown, ack?: (r: SubscribeAck) => void) => {
				const name = typeof channel === "string" ? channel : "";
				const room = joined.get(name);
				if (room) {
					joined.delete(name);
					await socket.leave(room);
				}
				// leaving what you never joined is the state you asked for
				if (typeof ack === "function") ack({ ok: true, channel: name });
			});
		});
		io = server_;
		onShutdown("realtime", () => new Promise<void>((resolve) => server_.close(() => resolve())));
		log.info({ path: options.path ?? "/realtime" }, "realtime attached");
	}

	return {
		issueTicket,
		attach,
		/** every socket the user has open in the org; arrives on channel "user:<userId>" */
		async publishToUser(orgId: string, userId: string, event: string, payload: unknown) {
			await publish(orgId, userRoom({ orgId, userId }), userChannel(userId), event, payload);
		},
		/** every socket in the org; arrives on channel "org" */
		async publishToOrg(orgId: string, event: string, payload: unknown) {
			await publish(orgId, orgRoom(orgId), ORG_CHANNEL, event, payload);
		},
		/**
		 * Subscribers of one channel, typed by its definition. Never throws: a bad param, event or
		 * payload is logged and the event dropped.
		 */
		async publishTo<
			P extends string,
			E extends Record<string, z.ZodType>,
			Ev extends keyof E & string,
		>(
			channel: ChannelDefinition<P, E>,
			input: {
				orgId: string;
				params: ChannelParams<NoInfer<P>>;
				event: Ev;
				payload: z.input<E[Ev]>;
			},
		): Promise<void> {
			const context = { channel: channel.name, event: input.event, orgId: input.orgId };
			let name: string;
			let payload: unknown;
			try {
				if (!input.orgId) throw new Error("orgId is required");
				const schema = channel.events[input.event];
				if (!schema) throw new Error(`no event "${input.event}"`);
				const parsed = schema.safeParse(input.payload);
				if (!parsed.success) {
					log.error(
						{ ...context, issues: parsed.error.issues },
						"realtime payload does not match the channel's schema, event dropped",
					);
					return;
				}
				payload = parsed.data;
				name = channelName(channel.name, (input.params ?? {}) as Record<string, string>);
			} catch (err) {
				log.error({ err, ...context }, "realtime publish rejected, event dropped");
				return;
			}
			await publish(
				input.orgId,
				channelRoom(input.orgId, channel.name, name),
				name,
				input.event,
				payload,
			);
		},
		/** closes the user's sockets in the org after `rt:closed { reason }`; the client reconnects */
		async disconnectUser(orgId: string, userId: string, reason: DisconnectReason) {
			await disconnect(orgId, userRoom({ orgId, userId }), reason);
		},
		async disconnectOrg(orgId: string, reason: DisconnectReason) {
			await disconnect(orgId, orgRoom(orgId), reason);
		},
	};
}

export type Realtime = ReturnType<typeof createRealtime>;
