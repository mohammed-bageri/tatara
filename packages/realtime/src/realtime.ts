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
import { createMetrics, type RealtimeMeter } from "./metrics.ts";

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
	/**
	 * Refuse a handshake with no Origin header (default false). Browsers always send one; mobile
	 * apps, scripts and server-side clients don't, and their ticket still authenticates them.
	 */
	requireOrigin?: boolean;
	/** default ["websocket"]; "polling" needs sticky sessions at the proxy with several processes */
	transports?: ("websocket" | "polling")[];
	/**
	 * Sockets one user may hold in one org on this process (default 10, 0: no cap). Past it the new
	 * socket gets `rt:closed { reason: "too_many_connections" }` and is closed.
	 */
	maxSocketsPerUser?: number;
	/** Largest frame a client may send (default 8 KB): clients only send subscribe/unsubscribe. */
	maxFrameBytes?: number;
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
	/** Records the counters on it too, e.g. `metrics.getMeter("app.realtime")` from @opentelemetry/api. */
	meter?: RealtimeMeter;
	logger: CoreLogger;
}

export interface RealtimeHealth {
	/** "disabled" with the noop driver: off on purpose, not a readiness failure */
	status: "healthy" | "unhealthy" | "disabled";
	driver: "socketio" | "noop";
	adapter?: "redis" | "memory";
	/** sockets held by this process */
	connections?: number;
	detail?: { attached: boolean; closed: boolean };
	error?: string;
}

type Emitter = {
	to(room: string): { emit(event: string, payload: unknown): unknown };
	in(room: string): { disconnectSockets(close?: boolean): unknown };
};

const NOOP: Emitter = {
	to: () => ({ emit: () => true }),
	in: () => ({ disconnectSockets: () => undefined }),
};

/** `live` is false when the event goes nowhere (noop, closed, or detached without Redis). */
type Target = { emitter: Emitter; flush: () => Promise<unknown>; live: boolean };

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
	const metrics = createMetrics(options.meter);
	let io: Server | undefined;
	let emitter: Promise<Target> | undefined;
	let channels: readonly AnyChannel[] = [];
	let closed = false;
	/** every Redis connection this instance opened, so close() and health() see them all */
	const redisClients: Redis[] = [];
	const socketsByUser = new Map<string, Set<string>>();
	let shutdownRegistered = false;
	// close() is idempotent, so an app that calls it in its own shutdown order can keep this hook
	const registerShutdown = () => {
		if (shutdownRegistered) return;
		shutdownRegistered = true;
		onShutdown("realtime", close);
	};
	const redisClient = (factory: () => Redis) => {
		const client = factory();
		redisClients.push(client);
		return client;
	};

	const done = async () => {};
	const NOWHERE: Target = { emitter: NOOP, flush: done, live: false };
	/** where a publish goes: the attached server, else Redis (other processes), else nowhere */
	const target = (): Promise<Target> => {
		if (options.driver === "noop" || closed) return Promise.resolve(NOWHERE);
		if (io) return Promise.resolve({ emitter: io as unknown as Emitter, flush: done, live: true });
		const adapter = options.adapter;
		if (adapter.kind !== "redis") return Promise.resolve(NOWHERE);
		emitter ??= import("@socket.io/redis-emitter").then(({ Emitter }) => {
			const client = redisClient(adapter.redis);
			registerShutdown();
			// the emitter publishes without waiting; a PING on the same connection answers only after
			// what came before it went out, so a process may exit once a publish resolves
			return {
				emitter: new Emitter(quietPublish(client)) as unknown as Emitter,
				flush: () => client.ping(),
				live: true,
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
	const send = async (
		fn: (emitter: Emitter) => unknown,
		context: Record<string, unknown>,
	): Promise<"sent" | "failed" | "nowhere"> => {
		let t: Target;
		try {
			t = await target();
			if (!t.live) return "nowhere";
			fn(t.emitter);
		} catch (err) {
			log.error({ err, ...context }, "realtime publish failed");
			return "failed";
		}
		try {
			await withTimeout(t.flush(), publishTimeoutMs);
		} catch (err) {
			log.warn({ err, ...context }, "realtime publish flush failed");
			return "failed";
		}
		return "sent";
	};
	const publish = async (orgId: string, room: string, ch: string, ev: string, data: unknown) => {
		const sent = await send((e) => e.to(room).emit(WIRE_EVENT, createEnvelope(ch, ev, data)), {
			orgId,
			channel: ch,
			event: ev,
		});
		if (sent !== "nowhere") metrics.published(sent === "sent");
	};
	const disconnect = async (orgId: string, room: string, reason: DisconnectReason) => {
		const sent = await send(
			(e) => {
				e.to(room).emit(WIRE_CLOSED_EVENT, { reason });
				e.in(room).disconnectSockets(true);
			},
			{ orgId, reason },
		);
		if (sent === "sent") metrics.disconnected(reason);
	};

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

	const allowed = (origin: string | undefined) =>
		origin ? options.allowOrigin(origin) : !options.requireOrigin;

	async function attach(
		server: HttpServer,
		opts: { channels?: readonly AnyChannel[] } = {},
	): Promise<void> {
		if (options.driver === "noop") return;
		if (io) throw new Error("realtime is already attached");
		if (closed) throw new Error("realtime is closed");
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
		const adapter = await (options.adapter.kind === "redis"
			? (async (redis) => {
					const { createAdapter } = await import("@socket.io/redis-adapter");
					const pub = redisClient(redis);
					const sub = redisClient(() => pub.duplicate());
					return createAdapter(pub, sub);
				})(options.adapter.redis)
			: undefined);
		// after an await on purpose: @tatara/http registers its server's hook right after onServer
		// returns, and hooks run last-registered first, so the sockets close before the server waits
		// on them
		registerShutdown();
		const path = options.path ?? "/realtime";
		const server_ = new Server(server, {
			path,
			transports: options.transports ?? ["websocket"],
			serveClient: false,
			perMessageDeflate: false,
			maxHttpBufferSize: options.maxFrameBytes ?? 8 * 1024,
			// browsers send Origin on the upgrade; CORS headers alone wouldn't stop it
			allowRequest: (req, cb) => {
				if (closed) return cb(null, false);
				const ok = allowed(req.headers.origin);
				if (!ok) metrics.rejected("origin");
				cb(null, ok);
			},
			cors: { origin: (origin, cb) => cb(null, allowed(origin)), credentials: true },
			...(adapter ? { adapter } : {}),
		});
		server_.use(async (socket, next) => {
			const ticket = (socket.handshake.auth as { ticket?: unknown } | undefined)?.ticket;
			if (typeof ticket !== "string" || ticket.length === 0) {
				metrics.rejected("no_ticket");
				return next(new Error("unauthorized"));
			}
			const who = await redeem(ticket);
			if (!who) {
				metrics.rejected("bad_ticket");
				return next(new Error("unauthorized"));
			}
			socket.data.who = who;
			next();
		});
		const maxSubscriptions = options.maxSubscriptionsPerSocket ?? 50;
		const lifetimeMs = options.maxSocketLifetimeMs ?? 15 * 60 * 1000;
		const maxSockets = options.maxSocketsPerUser ?? 10;
		server_.on("connection", (socket) => {
			const who = socket.data.who as SocketIdentity;
			const key = userRoom(who);
			const open = socketsByUser.get(key) ?? new Set<string>();
			if (maxSockets > 0 && open.size >= maxSockets) {
				// per process: across n processes a user can hold n × the cap, still bounded
				log.warn(
					{ userId: who.userId, orgId: who.orgId, open: open.size },
					"realtime per-user socket cap reached, closing the new socket",
				);
				metrics.rejected("too_many_connections");
				socket.emit(WIRE_CLOSED_EVENT, { reason: "too_many_connections" });
				socket.disconnect(true);
				return;
			}
			open.add(socket.id);
			socketsByUser.set(key, open);
			metrics.opened();
			socket.on("disconnect", () => {
				metrics.closed();
				open.delete(socket.id);
				if (open.size === 0 && socketsByUser.get(key) === open) socketsByUser.delete(key);
			});
			void socket.join([userRoom(who), orgRoom(who.orgId)]);
			if (lifetimeMs > 0) {
				// jittered so the sockets opened during a deploy don't all reconnect in one burst
				const jittered = lifetimeMs * (1 + 0.1 * (Math.random() * 2 - 1));
				const expire = setTimeout(() => {
					metrics.disconnected("session_invalid");
					socket.emit(WIRE_CLOSED_EVENT, { reason: "session_invalid" });
					socket.disconnect(true);
				}, jittered);
				socket.on("disconnect", () => clearTimeout(expire));
			}
			const joined = new Map<string, string>();
			// subscriptions being authorized count toward the cap, so a burst can't pass it
			let pending = 0;
			socket.on("subscribe", async (channel: unknown, ack?: (r: SubscribeAck) => void) => {
				const reply = (r: SubscribeAck) => {
					metrics.subscribed(r.ok ? "allowed" : (r.code ?? "FORBIDDEN"));
					if (typeof ack === "function") ack(r);
				};
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
		log.info({ path }, "realtime attached");
	}

	/**
	 * Closes this process's sockets and Redis connections, leaving the HTTP server it was attached
	 * to running (the app closes that, after). Idempotent; publishes after it are dropped.
	 */
	async function close(): Promise<void> {
		if (closed) return;
		closed = true;
		if (io) {
			// not io.close(): that closes the HTTP server too, which the app owns
			io.local.disconnectSockets(true);
			io.engine.close();
			io = undefined;
		}
		socketsByUser.clear();
		await Promise.all(
			redisClients.splice(0).map((client) =>
				client.quit().then(
					() => {},
					() => client.disconnect(),
				),
			),
		);
	}

	async function health(): Promise<RealtimeHealth> {
		if (options.driver === "noop") return { status: "disabled", driver: "noop" };
		const base = {
			driver: "socketio" as const,
			adapter: options.adapter.kind,
			connections: metrics.snapshot().connectionsOpen,
			detail: { attached: io !== undefined, closed },
		};
		if (closed) return { ...base, status: "unhealthy", error: "realtime is closed" };
		// a process that never attached publishes through Redis once it has, and is healthy before
		if (redisClients.some((client) => client.status !== "ready"))
			return { ...base, status: "unhealthy", error: "redis connection is not ready" };
		return { ...base, status: "healthy" };
	}

	return {
		issueTicket,
		attach,
		close,
		health,
		/** this process's counts since it started, e.g. for a readiness probe */
		metrics: metrics.snapshot,
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
					if (options.driver !== "noop") metrics.published(false);
					log.error(
						{ ...context, issues: parsed.error.issues },
						"realtime payload does not match the channel's schema, event dropped",
					);
					return;
				}
				payload = parsed.data;
				name = channelName(channel.name, (input.params ?? {}) as Record<string, string>);
			} catch (err) {
				if (options.driver !== "noop") metrics.published(false);
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
