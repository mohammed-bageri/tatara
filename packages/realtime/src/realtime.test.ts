import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { pino } from "pino";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	type ChannelDefinition,
	createRealtime,
	defineChannel,
	matchChannel,
	type RealtimeEnvelope,
	type SocketIdentity,
	type TicketStore,
} from "./index.ts";

const logger = pino({ level: "silent" });

/** A pino logger that keeps every error and warning it is given. */
function capturingLogger() {
	const logged: { obj: unknown; msg: unknown }[] = [];
	const captured = pino(
		{
			level: "warn",
			hooks: {
				logMethod(args, method) {
					logged.push(
						typeof args[0] === "string"
							? { obj: undefined, msg: args[0] }
							: { obj: args[0], msg: args[1] },
					);
					return method.apply(this, args);
				},
			},
		},
		{ write() {} },
	);
	return { logged, logger: captured };
}

function memoryTickets(): TicketStore {
	const map = new Map<string, SocketIdentity>();
	return {
		async add(key, value) {
			if (map.has(key)) return false;
			map.set(key, value);
			return true;
		},
		async take(key) {
			const value = map.get(key) ?? null;
			map.delete(key);
			return value;
		},
	};
}

const survey = defineChannel({
	name: "survey.{surveyId}",
	description: "live answers",
	events: { "answer.created": z.object({ answerId: z.string() }) },
	authorize: (who, { surveyId }) => surveyId !== "secret" || who.userId === "owner",
});

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

async function serve(
	options: Partial<Parameters<typeof createRealtime>[0]> = {},
	// biome-ignore lint/suspicious/noExplicitAny: channels with any params and events
	channels: readonly ChannelDefinition<string, any>[] = [survey],
) {
	const tickets = options.tickets ?? memoryTickets();
	const realtime = createRealtime({
		driver: "socketio",
		adapter: { kind: "memory" },
		tickets,
		allowOrigin: () => true,
		logger,
		...options,
	});
	const server: Server = createServer();
	await realtime.attach(server, { channels });
	await new Promise<void>((r) => server.listen(0, r));
	cleanups.push(() => new Promise((r) => server.close(r)));
	const url = `http://localhost:${(server.address() as AddressInfo).port}`;
	return { realtime, url, tickets };
}

async function socketFor(url: string, ticket: string | undefined): Promise<Socket> {
	const socket = connect(url, {
		path: "/realtime",
		transports: ["websocket"],
		auth: { ticket },
		reconnection: false,
	});
	cleanups.push(() => socket.close());
	await new Promise<void>((resolve, reject) => {
		socket.on("connect", () => resolve());
		socket.on("connect_error", reject);
	});
	return socket;
}

type Served = Awaited<ReturnType<typeof serve>>;
const socketOf = async ({ realtime, url }: Served, who: SocketIdentity) =>
	socketFor(url, (await realtime.issueTicket(who)).ticket);

/** the next envelope carrying `event` */
const nextEnvelope = (socket: Socket, event: string) =>
	new Promise<RealtimeEnvelope>((resolve) => {
		const on = (envelope: RealtimeEnvelope) => {
			if (envelope.ev !== event) return;
			socket.off("rt", on);
			resolve(envelope);
		};
		socket.on("rt", on);
	});
const next = async (socket: Socket, event: string) => (await nextEnvelope(socket, event)).data;
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("realtime", () => {
	it("trades a ticket for a socket, once", async () => {
		const { realtime, url } = await serve();
		const { ticket } = await realtime.issueTicket({ userId: "u1", orgId: "o1" });
		await socketFor(url, ticket);
		await expect(socketFor(url, ticket)).rejects.toThrow(/unauthorized/);
		await expect(socketFor(url, undefined)).rejects.toThrow(/unauthorized/);
	});

	it("refuses and logs when the ticket store fails", async () => {
		const { logged, logger: captured } = capturingLogger();
		const tickets = memoryTickets();
		const served = await serve({
			logger: captured,
			tickets: { ...tickets, take: () => Promise.reject(new Error("redis down")) },
		});
		await expect(socketOf(served, { userId: "u1", orgId: "o1" })).rejects.toThrow(/unauthorized/);
		expect(logged.some((l) => String(l.msg).includes("ticket lookup failed"))).toBe(true);
	});

	it("carries the ticket's sessionId on the socket identity", async () => {
		const seen: SocketIdentity[] = [];
		const watched = defineChannel({
			name: "watched",
			description: "",
			events: { e: z.object({}) },
			authorize: (who) => {
				seen.push(who);
				return true;
			},
		});
		const served = await serve({}, [watched]);
		const socket = await socketOf(served, { userId: "u1", orgId: "o1", sessionId: "s-1" });
		await socket.emitWithAck("subscribe", "watched");
		expect(seen).toEqual([{ userId: "u1", orgId: "o1", sessionId: "s-1" }]);
	});

	it("delivers every event as an rt envelope, to the user's sockets and the org's only", async () => {
		const served = await serve();
		const me = await socketOf(served, { userId: "u1", orgId: "o1" });
		const colleague = await socketOf(served, { userId: "u2", orgId: "o1" });
		const sameUserOtherOrg = await socketOf(served, { userId: "u1", orgId: "o2" });
		const leaked: unknown[] = [];
		sameUserOtherOrg.onAny((event, payload) => leaked.push([event, payload]));
		const theirs: unknown[] = [];
		colleague.on("rt", (p) => theirs.push(p));
		const raw: string[] = [];
		me.onAny((event) => raw.push(event));

		const mine = nextEnvelope(me, "notification.created");
		const before = Date.now();
		await served.realtime.publishToUser("o1", "u1", "notification.created", { id: "n1" });
		const envelope = await mine;
		expect(envelope).toEqual({
			id: expect.any(String),
			v: 1,
			ch: "user:u1",
			ev: "notification.created",
			ts: expect.any(Number),
			data: { id: "n1" },
		});
		expect(envelope.ts).toBeGreaterThanOrEqual(before);
		expect(raw).toEqual(["rt"]);

		const both = Promise.all([nextEnvelope(me, "org.news"), nextEnvelope(colleague, "org.news")]);
		await served.realtime.publishToOrg("o1", "org.news", { title: "hi" });
		const [a, b] = await both;
		expect(a).toMatchObject({ v: 1, ch: "org", ev: "org.news", data: { title: "hi" } });
		expect(b).toMatchObject({ ch: "org", data: { title: "hi" } });
		expect(a.id).not.toBe(envelope.id);
		expect(theirs).toHaveLength(1);
		expect(leaked).toEqual([]);
	});

	it("acks subscribe and unsubscribe with the channel and a machine code", async () => {
		const served = await serve({ maxSubscriptionsPerSocket: 2 });
		const socket = await socketOf(served, { userId: "u1", orgId: "o1" });
		const ask = (channel: unknown) => socket.emitWithAck("subscribe", channel);
		expect(await ask("survey.s1")).toEqual({ ok: true, channel: "survey.s1" });
		expect(await ask("survey.s1")).toEqual({ ok: true, channel: "survey.s1" });
		expect(await ask("survey.secret")).toEqual({
			ok: false,
			channel: "survey.secret",
			code: "FORBIDDEN",
		});
		expect(await ask("survey.a|b")).toEqual({
			ok: false,
			channel: "survey.a|b",
			code: "CHANNEL_UNKNOWN",
		});
		expect(await ask("nope")).toEqual({ ok: false, channel: "nope", code: "CHANNEL_UNKNOWN" });
		expect(await ask(42)).toEqual({ ok: false, channel: "", code: "CHANNEL_INVALID" });
		expect(await ask("")).toEqual({ ok: false, channel: "", code: "CHANNEL_INVALID" });
		expect(await ask("survey.s2")).toEqual({ ok: true, channel: "survey.s2" });
		expect(await ask("survey.s3")).toEqual({
			ok: false,
			channel: "survey.s3",
			code: "TOO_MANY_SUBSCRIPTIONS",
		});
		expect(await socket.emitWithAck("unsubscribe", "survey.s2")).toEqual({
			ok: true,
			channel: "survey.s2",
		});
		expect(await socket.emitWithAck("unsubscribe", "never")).toEqual({
			ok: true,
			channel: "never",
		});
		expect(await ask("survey.s3")).toEqual({ ok: true, channel: "survey.s3" });
	});

	it("checks the channel's feature, then its permission, then authorize", async () => {
		const calls: string[] = [];
		const reports = defineChannel({
			name: "reports.{reportId}",
			description: "",
			events: { ready: z.object({}) },
			feature: "reports",
			permission: "reports.read",
			authorize: (_who, { reportId }) => {
				calls.push(`authorize:${reportId}`);
				return reportId !== "private";
			},
		});
		const served = await serve(
			{
				featureAllowed: (orgId, feature) => {
					calls.push(`feature:${feature}`);
					return orgId !== "free";
				},
				checkPermission: (who, permission) => {
					calls.push(`permission:${permission}`);
					if (who.userId === "broken") throw new Error("authz down");
					return who.userId !== "guest";
				},
			},
			[reports],
		);
		const codeFor = async (who: SocketIdentity, channel: string) =>
			((await (await socketOf(served, who)).emitWithAck("subscribe", channel)) as { code?: string })
				.code;

		expect(await codeFor({ userId: "u1", orgId: "free" }, "reports.r1")).toBe("ENTITLEMENT_DENIED");
		expect(calls).toEqual(["feature:reports"]);
		calls.length = 0;
		expect(await codeFor({ userId: "guest", orgId: "o1" }, "reports.r1")).toBe("PERMISSION_DENIED");
		expect(calls).toEqual(["feature:reports", "permission:reports.read"]);
		calls.length = 0;
		expect(await codeFor({ userId: "u1", orgId: "o1" }, "reports.private")).toBe("FORBIDDEN");
		expect(calls).toEqual(["feature:reports", "permission:reports.read", "authorize:private"]);
		expect(await codeFor({ userId: "broken", orgId: "o1" }, "reports.r1")).toBe("FORBIDDEN");
		expect(await codeFor({ userId: "u1", orgId: "o1" }, "reports.r1")).toBeUndefined();
	});

	it("lets any org member subscribe to a channel without checks", async () => {
		const open = defineChannel({ name: "lobby", description: "", events: { e: z.object({}) } });
		const served = await serve({}, [open]);
		const socket = await socketOf(served, { userId: "u1", orgId: "o1" });
		expect(await socket.emitWithAck("subscribe", "lobby")).toEqual({ ok: true, channel: "lobby" });
	});

	it("publishes typed events to a channel's subscribers as envelopes", async () => {
		const served = await serve();
		const socket = await socketOf(served, { userId: "u1", orgId: "o1" });
		await socket.emitWithAck("subscribe", "survey.s1");
		const got = nextEnvelope(socket, "answer.created");
		await served.realtime.publishTo(survey, {
			orgId: "o1",
			params: { surveyId: "s1" },
			event: "answer.created",
			payload: { answerId: "a1" },
		});
		expect(await got).toMatchObject({
			v: 1,
			ch: "survey.s1",
			ev: "answer.created",
			data: { answerId: "a1" },
		});
	});

	it("logs and drops a publish with a bad param, event or payload, never throwing", async () => {
		const { logged, logger: captured } = capturingLogger();
		const served = await serve({ logger: captured });
		const socket = await socketOf(served, { userId: "u1", orgId: "o1" });
		await socket.emitWithAck("subscribe", "survey.s1");
		const received: unknown[] = [];
		socket.on("rt", (e) => received.push(e));
		const { publishTo } = served.realtime;
		await expect(
			publishTo(survey, {
				orgId: "o1",
				params: { surveyId: "s1" },
				event: "answer.created",
				// @ts-expect-error the payload is checked at compile time
				payload: { answerId: 1 },
			}),
		).resolves.toBeUndefined();
		await expect(
			publishTo(survey, {
				orgId: "o1",
				params: { surveyId: "s.1" },
				event: "answer.created",
				payload: { answerId: "a1" },
			}),
		).resolves.toBeUndefined();
		await expect(
			publishTo(survey, {
				orgId: "o1",
				// @ts-expect-error the params come from the pattern
				params: { other: "s1" },
				event: "answer.created",
				payload: { answerId: "a1" },
			}),
		).resolves.toBeUndefined();
		await expect(
			publishTo(survey, {
				orgId: "o1",
				params: { surveyId: "s1" },
				// @ts-expect-error the event names come from the channel
				event: "answer.deleted",
				payload: { answerId: "a1" },
			}),
		).resolves.toBeUndefined();
		await settle();
		expect(received).toEqual([]);
		expect(logged.filter((l) => String(l.msg).includes("dropped"))).toHaveLength(4);
	});

	it("never throws when the transport fails", async () => {
		const { logged, logger: captured } = capturingLogger();
		const realtime = createRealtime({
			driver: "socketio",
			adapter: {
				kind: "redis",
				redis: () => {
					throw new Error("no redis");
				},
			},
			tickets: memoryTickets(),
			allowOrigin: () => true,
			logger: captured,
		});
		await expect(realtime.publishToOrg("o1", "x", {})).resolves.toBeUndefined();
		await expect(realtime.disconnectOrg("o1", "tenant_suspended")).resolves.toBeUndefined();
		expect(logged.some((l) => String(l.msg).includes("publish failed"))).toBe(true);
	});

	it("tells a user's sockets why before closing them", async () => {
		const served = await serve();
		const socket = await socketOf(served, { userId: "u1", orgId: "o1" });
		const other = await socketOf(served, { userId: "u2", orgId: "o1" });
		const order: unknown[] = [];
		socket.on("rt:closed", (p) => order.push(["rt:closed", p]));
		const closed = new Promise((r) => socket.on("disconnect", () => r(order.push("disconnect"))));
		await served.realtime.disconnectUser("o1", "u1", "permissions_changed");
		await closed;
		expect(order).toEqual([["rt:closed", { reason: "permissions_changed" }], "disconnect"]);
		await settle();
		expect(other.connected).toBe(true);
	});

	it("tells every socket in the org why before closing them", async () => {
		const served = await serve();
		const sockets = [
			await socketOf(served, { userId: "u1", orgId: "o1" }),
			await socketOf(served, { userId: "u2", orgId: "o1" }),
		];
		const reasons = Promise.all(
			sockets.map(
				(s) =>
					new Promise((resolve) => {
						let reason: unknown;
						s.on("rt:closed", (p: { reason: string }) => {
							reason = p.reason;
						});
						s.on("disconnect", () => resolve(reason));
					}),
			),
		);
		await served.realtime.disconnectOrg("o1", "tenant_suspended");
		expect(await reasons).toEqual(["tenant_suspended", "tenant_suspended"]);
	});

	it("holds the subscription cap under a burst of subscribes", async () => {
		const served = await serve({ maxSubscriptionsPerSocket: 3 });
		const socket = await socketOf(served, { userId: "u1", orgId: "o1" });
		const replies = await Promise.all(
			Array.from({ length: 20 }, (_, i) => socket.emitWithAck("subscribe", `survey.s${i}`)),
		);
		expect(replies.filter((r: { ok: boolean }) => r.ok)).toHaveLength(3);
		expect(
			replies.filter((r: { code?: string }) => r.code === "TOO_MANY_SUBSCRIPTIONS"),
		).toHaveLength(17);
	});

	it("refuses a handshake from an origin the app doesn't allow", async () => {
		const { realtime, url } = await serve({ allowOrigin: (o) => o === "https://app.example.com" });
		const { ticket } = await realtime.issueTicket({ userId: "u1", orgId: "o1" });
		const socket = connect(url, {
			path: "/realtime",
			transports: ["websocket"],
			auth: { ticket },
			reconnection: false,
			extraHeaders: { origin: "https://evil.example" },
		});
		cleanups.push(() => socket.close());
		await expect(
			new Promise<void>((resolve, reject) => {
				socket.on("connect", () => resolve());
				socket.on("connect_error", reject);
			}),
		).rejects.toThrow();
	});

	it("closes a socket after its lifetime with session_invalid, jittered by up to 10%", async () => {
		const served = await serve({ maxSocketLifetimeMs: 1000 });
		// the lowest jitter: 900 ms
		const random = vi.spyOn(Math, "random").mockReturnValue(0);
		const socket = await socketOf(served, { userId: "u1", orgId: "o1" }).finally(() =>
			random.mockRestore(),
		);
		const start = Date.now();
		const reason = new Promise((r) =>
			socket.on("rt:closed", (p: { reason: string }) => r(p.reason)),
		);
		await new Promise((r) => socket.on("disconnect", r));
		const elapsed = Date.now() - start;
		expect(await reason).toBe("session_invalid");
		expect(elapsed).toBeGreaterThanOrEqual(800);
		expect(elapsed).toBeLessThan(990);
	});

	it("keeps overlapping channel patterns apart", async () => {
		const left = defineChannel({
			name: "a.{x}",
			description: "",
			events: { e: z.object({}) },
			authorize: () => true,
		});
		const right = defineChannel({
			name: "{y}.b",
			description: "",
			events: { e: z.object({}) },
			authorize: () => false,
		});
		const served = await serve({}, [left, right]);
		const socket = await socketOf(served, { userId: "u1", orgId: "o1" });
		expect(await socket.emitWithAck("subscribe", "a.b")).toEqual({ ok: true, channel: "a.b" });
		const leaked: unknown[] = [];
		socket.on("rt", (p) => leaked.push(p));
		// "a.b" also matches {y}.b, which this socket may not read
		await served.realtime.publishTo(right, {
			orgId: "o1",
			params: { y: "a" },
			event: "e",
			payload: {},
		});
		await new Promise((r) => setTimeout(r, 200));
		expect(leaked).toEqual([]);
	});

	it("refuses to attach channels it can't route", async () => {
		const events = { e: z.object({}) };
		const attachWith = (
			// biome-ignore lint/suspicious/noExplicitAny: channels with any params and events
			channels: ChannelDefinition<string, any>[],
			options: Partial<Parameters<typeof createRealtime>[0]> = {},
		) =>
			createRealtime({
				driver: "socketio",
				adapter: { kind: "memory" },
				tickets: memoryTickets(),
				allowOrigin: () => true,
				logger,
				...options,
			}).attach(createServer(), { channels });
		const channel = (name: string, extra: object = {}) =>
			defineChannel({ name, description: "", events, ...extra });
		await expect(attachWith([channel("org")])).rejects.toThrow(/reserved/);
		await expect(attachWith([channel("org.news")])).rejects.toThrow(/reserved/);
		await expect(attachWith([channel("user.{id}")])).rejects.toThrow(/reserved/);
		await expect(attachWith([channel("a.b"), channel("a.b")])).rejects.toThrow(/twice/);
		await expect(attachWith([channel("a.{x}.{x}")])).rejects.toThrow(/twice/);
		await expect(attachWith([channel("a b")])).rejects.toThrow(/invalid segment/);
		await expect(attachWith([channel("a..b")])).rejects.toThrow(/invalid segment/);
		await expect(attachWith([channel("a:b")])).rejects.toThrow(/invalid segment/);
		await expect(attachWith([channel("")])).rejects.toThrow(/non-empty/);
		await expect(
			attachWith([defineChannel({ name: "a", description: "", events: {} })]),
		).rejects.toThrow(/at least one event/);
		await expect(attachWith([channel("a", { permission: "x.read" })])).rejects.toThrow(
			/checkPermission/,
		);
		await expect(attachWith([channel("a", { feature: "x" })])).rejects.toThrow(/featureAllowed/);
		const server = createServer();
		cleanups.push(() => new Promise((r) => server.close(r)));
		await expect(
			createRealtime({
				driver: "socketio",
				adapter: { kind: "memory" },
				tickets: memoryTickets(),
				allowOrigin: () => true,
				logger,
			}).attach(server, { channels: [channel("users.{id}"), channel("organization")] }),
		).resolves.toBeUndefined();
	});

	it("matches channel patterns with safe params only", () => {
		expect(matchChannel("survey.{surveyId}", "survey.s-1_A")).toEqual({ surveyId: "s-1_A" });
		expect(matchChannel("survey.{surveyId}", "survey.s.1")).toBeNull();
		expect(matchChannel("a.{x}.b.{y}", "a.1.b.2")).toEqual({ x: "1", y: "2" });
	});

	it("publishes nothing and attaches nothing with the noop driver", async () => {
		const realtime = createRealtime({
			driver: "noop",
			adapter: { kind: "memory" },
			tickets: memoryTickets(),
			allowOrigin: () => true,
			logger,
		});
		await realtime.attach(createServer());
		await realtime.publishToUser("o1", "u1", "x", {});
	});
});

const REDIS_URL = process.env.TATARA_TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)("realtime across processes (Redis)", { timeout: 20_000 }, () => {
	it("reaches sockets on every api process, published from a process with no sockets", async () => {
		const tickets = memoryTickets();
		const redis = () => {
			const client = new Redis(REDIS_URL as string);
			cleanups.push(() => client.quit());
			return client;
		};
		const a = await serve({ adapter: { kind: "redis", redis }, tickets });
		const b = await serve({ adapter: { kind: "redis", redis }, tickets });
		const onA = await socketFor(
			a.url,
			(await a.realtime.issueTicket({ userId: "u1", orgId: "o1" })).ticket,
		);
		const onB = await socketFor(
			b.url,
			(await b.realtime.issueTicket({ userId: "u1", orgId: "o1" })).ticket,
		);
		// a worker: never attached, publishes through Redis
		const worker = createRealtime({
			driver: "socketio",
			adapter: { kind: "redis", redis },
			tickets,
			allowOrigin: () => true,
			logger,
		});
		const both = Promise.all([next(onA, "ping"), next(onB, "ping")]);
		await new Promise((r) => setTimeout(r, 300));
		await worker.publishToUser("o1", "u1", "ping", { n: 1 });
		expect(await both).toEqual([{ n: 1 }, { n: 1 }]);
	});

	it("sends the close reason through Redis before the sockets close", async () => {
		const tickets = memoryTickets();
		const redis = () => {
			const client = new Redis(REDIS_URL as string);
			cleanups.push(() => client.quit());
			return client;
		};
		const api = await serve({ adapter: { kind: "redis", redis }, tickets });
		const socket = await socketOf(api, { userId: "u1", orgId: "o1" });
		const order: unknown[] = [];
		socket.on("rt:closed", (p) => order.push(p));
		const closed = new Promise((r) => socket.on("disconnect", () => r(order.push("disconnect"))));
		const worker = createRealtime({
			driver: "socketio",
			adapter: { kind: "redis", redis },
			tickets,
			allowOrigin: () => true,
			logger,
		});
		await new Promise((r) => setTimeout(r, 300));
		await worker.disconnectUser("o1", "u1", "logged_out");
		await closed;
		expect(order).toEqual([{ reason: "logged_out" }, "disconnect"]);
	});

	it("logs and drops a publish when Redis ping rejects, never throwing to the caller", async () => {
		const warnings: unknown[] = [];
		const testLogger = pino({
			level: "warn",
			hooks: {
				logMethod(args, method) {
					warnings.push(args[0]);
					return method.apply(this, args);
				},
			},
		});
		const worker = createRealtime({
			driver: "socketio",
			adapter: {
				kind: "redis",
				redis: () => {
					const client = new Redis("redis://localhost:1", {
						maxRetriesPerRequest: 1,
						retryStrategy: () => null,
					});
					cleanups.push(() => client.disconnect());
					return client;
				},
			},
			tickets: memoryTickets(),
			allowOrigin: () => true,
			logger: testLogger,
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on("unhandledRejection", onUnhandled);
		cleanups.push(() => process.off("unhandledRejection", onUnhandled));
		await worker.publishToUser("o1", "u1", "x", {});
		await new Promise((r) => setTimeout(r, 100));
		expect(unhandled).toEqual([]);
		expect(warnings.some((w: any) => w?.err)).toBe(true);
	});

	it("logs and drops a publish when Redis ping hangs, resolving quickly", async () => {
		const warnings: unknown[] = [];
		const testLogger = pino({
			level: "warn",
			hooks: {
				logMethod(args, method) {
					warnings.push(args[0]);
					return method.apply(this, args);
				},
			},
		});
		const worker = createRealtime({
			driver: "socketio",
			adapter: {
				kind: "redis",
				redis: () => {
					const client = new Redis("redis://localhost:1", { lazyConnect: true });
					client.ping = (() => new Promise(() => {})) as typeof client.ping;
					cleanups.push(() => client.disconnect());
					return client;
				},
			},
			tickets: memoryTickets(),
			allowOrigin: () => true,
			logger: testLogger,
		});
		const start = Date.now();
		await worker.publishToUser("o1", "u1", "x", {});
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(2000);
		expect(warnings.some((w: any) => w?.err?.message?.includes("timeout"))).toBe(true);
	});

	it("has sent the event by the time publish resolves, so a short-lived process can exit", async () => {
		const tickets = memoryTickets();
		const clients: Redis[] = [];
		const redis = () => {
			const client = new Redis(REDIS_URL as string);
			clients.push(client);
			cleanups.push(() => client.quit().catch(() => {}));
			return client;
		};
		const api = await serve({ adapter: { kind: "redis", redis }, tickets });
		const socket = await socketFor(
			api.url,
			(await api.realtime.issueTicket({ userId: "u9", orgId: "o9" })).ticket,
		);
		const got = next(socket, "bye");
		await new Promise((r) => setTimeout(r, 300));
		// created on first publish, still connecting when the event is emitted (as in the app's CLI)
		let cliRedis: Redis | undefined;
		const cli = createRealtime({
			driver: "socketio",
			adapter: {
				kind: "redis",
				redis: () => {
					cliRedis = new Redis(REDIS_URL as string);
					return cliRedis;
				},
			},
			tickets,
			allowOrigin: () => true,
			logger,
		});
		await cli.publishToUser("o9", "u9", "bye", { last: true });
		// the process exits: no QUIT, nothing left to flush
		cliRedis?.disconnect();
		expect(
			await Promise.race([got, new Promise((r) => setTimeout(() => r("lost"), 3000))]),
		).toEqual({ last: true });
	});
});
