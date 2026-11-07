import { randomBytes } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { type CoreLogger, onShutdown } from "@tatara/core";
import type { Redis } from "ioredis";
import { Server } from "socket.io";
import {
	type ChannelDefinition,
	channelName,
	channelRoom,
	matchChannel,
	orgRoom,
	type SocketIdentity,
	userRoom,
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
	 * How long a socket lives before the server closes it (default 15 min, 0: forever). The client
	 * reconnects with a new ticket, so a user who lost access is checked again.
	 */
	maxSocketLifetimeMs?: number;
	/** Longest a publish waits for the adapter before giving up and logging (default 1000 ms). */
	publishTimeoutMs?: number;
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

/** The app's realtime: attach it to the api server; publish from anywhere. */
export function createRealtime(options: RealtimeOptions) {
	const ttlMs = options.ticketTtlMs ?? 60_000;
	let io: Server | undefined;
	let emitter: Promise<Target> | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: channels with any params and events
	let channels: readonly ChannelDefinition<string, any>[] = [];

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
	const send = async (fn: (emitter: Emitter) => unknown) => {
		const { emitter: e, flush } = await target();
		fn(e);
		try {
			await withTimeout(flush(), publishTimeoutMs);
		} catch (err) {
			options.logger.warn({ err }, "realtime publish flush failed");
		}
	};

	async function issueTicket(
		who: SocketIdentity,
	): Promise<{ ticket: string; expiresInMs: number }> {
		const ticket = `rt_${randomBytes(24).toString("base64url")}`;
		await options.tickets.add(`realtime:ticket:${ticket}`, who, { ttlMs });
		return { ticket, expiresInMs: ttlMs };
	}

	const allowed = (origin: string | undefined) => !origin || options.allowOrigin(origin);

	async function attach(
		server: HttpServer,
		// biome-ignore lint/suspicious/noExplicitAny: channels with any params and events
		opts: { channels?: readonly ChannelDefinition<string, any>[] } = {},
	): Promise<void> {
		if (options.driver === "noop") return;
		channels = opts.channels ?? [];
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
			const ticket = (socket.handshake.auth as { ticket?: unknown } | undefined)?.ticket;
			const who =
				typeof ticket === "string" && ticket.startsWith("rt_")
					? await options.tickets.take(`realtime:ticket:${ticket}`).catch(() => null)
					: null;
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
				const expire = setTimeout(() => socket.disconnect(true), lifetimeMs);
				socket.on("disconnect", () => clearTimeout(expire));
			}
			// counts subscriptions being authorized too, so a burst can't pass the cap
			let taken = 0;
			socket.on(
				"subscribe",
				async (channel: unknown, ack?: (r: { ok: boolean; error?: string }) => void) => {
					const reply = typeof ack === "function" ? ack : () => {};
					if (typeof channel !== "string") return reply({ ok: false, error: "invalid channel" });
					if (taken >= maxSubscriptions)
						return reply({ ok: false, error: "too many subscriptions" });
					taken++;
					for (const definition of channels) {
						const params = matchChannel(definition.name, channel);
						if (!params) continue;
						const ok = await Promise.resolve(definition.authorize(who, params)).catch(() => false);
						if (!ok) break;
						const room = channelRoom(who.orgId, definition.name, channel);
						if (socket.rooms.has(room)) taken--;
						else await socket.join(room);
						return reply({ ok: true });
					}
					taken--;
					reply({
						ok: false,
						error: channels.some((d) => matchChannel(d.name, channel))
							? "forbidden"
							: "unknown channel",
					});
				},
			);
			socket.on("unsubscribe", async (channel: unknown, ack?: (r: { ok: boolean }) => void) => {
				if (typeof channel === "string")
					for (const definition of channels) {
						const room = channelRoom(who.orgId, definition.name, channel);
						if (!socket.rooms.has(room)) continue;
						await socket.leave(room);
						taken--;
					}
				if (typeof ack === "function") ack({ ok: true });
			});
		});
		io = server_;
		onShutdown("realtime", () => new Promise<void>((resolve) => server_.close(() => resolve())));
		options.logger.info({ path: options.path ?? "/realtime" }, "realtime attached");
	}

	return {
		issueTicket,
		attach,
		/** every socket the user has open in the org */
		async publishToUser(orgId: string, userId: string, event: string, payload: unknown) {
			await send((e) => e.to(userRoom({ orgId, userId })).emit(event, payload));
		},
		/** every socket in the org */
		async publishToOrg(orgId: string, event: string, payload: unknown) {
			await send((e) => e.to(orgRoom(orgId)).emit(event, payload));
		},
		/** subscribers of one channel; the payload is checked against the channel's event schema */
		async publishTo<
			// biome-ignore lint/suspicious/noExplicitAny: any channel
			C extends ChannelDefinition<string, any>,
			Ev extends keyof C["events"] & string,
		>(
			channel: C,
			input: { orgId: string; params: Record<string, string>; event: Ev; payload: unknown },
		) {
			const schema = channel.events[input.event];
			if (!schema) throw new Error(`Channel ${channel.name} has no event "${input.event}"`);
			const payload = schema.parse(input.payload);
			const room = channelRoom(input.orgId, channel.name, channelName(channel.name, input.params));
			await send((e) => e.to(room).emit(input.event, payload));
		},
		/** closes the user's sockets in the org (access changed); the client reconnects with a new ticket */
		async disconnectUser(orgId: string, userId: string) {
			await send((e) => e.in(userRoom({ orgId, userId })).disconnectSockets(true));
		},
		async disconnectOrg(orgId: string) {
			await send((e) => e.in(orgRoom(orgId)).disconnectSockets(true));
		},
	};
}

export type Realtime = ReturnType<typeof createRealtime>;
