import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { pino } from "pino";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createRealtime,
	defineChannel,
	matchChannel,
	type SocketIdentity,
	type TicketStore,
} from "./index.ts";

const logger = pino({ level: "silent" });

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

async function serve(options: Partial<Parameters<typeof createRealtime>[0]> = {}) {
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
	await realtime.attach(server, { channels: [survey] });
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

const next = (socket: Socket, event: string) =>
	new Promise<unknown>((resolve) => socket.once(event, (payload: unknown) => resolve(payload)));

describe("realtime", () => {
	it("trades a ticket for a socket, once", async () => {
		const { realtime, url } = await serve();
		const { ticket } = await realtime.issueTicket({ userId: "u1", orgId: "o1" });
		await socketFor(url, ticket);
		await expect(socketFor(url, ticket)).rejects.toThrow(/unauthorized/);
		await expect(socketFor(url, undefined)).rejects.toThrow(/unauthorized/);
	});

	it("reaches a user's sockets and the org's, never another org's", async () => {
		const { realtime, url } = await serve();
		const me = await socketFor(
			url,
			(await realtime.issueTicket({ userId: "u1", orgId: "o1" })).ticket,
		);
		const colleague = await socketFor(
			url,
			(await realtime.issueTicket({ userId: "u2", orgId: "o1" })).ticket,
		);
		const sameUserOtherOrg = await socketFor(
			url,
			(await realtime.issueTicket({ userId: "u1", orgId: "o2" })).ticket,
		);
		const leaked: unknown[] = [];
		sameUserOtherOrg.onAny((event, payload) => leaked.push([event, payload]));
		const mine = next(me, "notification.created");
		const theirs: unknown[] = [];
		colleague.on("notification.created", (p) => theirs.push(p));
		await realtime.publishToUser("o1", "u1", "notification.created", { id: "n1" });
		expect(await mine).toEqual({ id: "n1" });
		const both = Promise.all([next(me, "org.news"), next(colleague, "org.news")]);
		await realtime.publishToOrg("o1", "org.news", { title: "hi" });
		expect(await both).toEqual([{ title: "hi" }, { title: "hi" }]);
		expect(theirs).toEqual([]);
		expect(leaked).toEqual([]);
	});

	it("lets a socket subscribe to a channel it's authorized for, with checked payloads", async () => {
		const { realtime, url } = await serve();
		const socket = await socketFor(
			url,
			(await realtime.issueTicket({ userId: "u1", orgId: "o1" })).ticket,
		);
		const ask = (channel: string) => socket.emitWithAck("subscribe", channel);
		expect(await ask("survey.s1")).toEqual({ ok: true });
		expect(await ask("survey.secret")).toEqual({ ok: false, error: "forbidden" });
		expect(await ask("survey.a|b")).toEqual({ ok: false, error: "unknown channel" });
		expect(await ask("nope")).toEqual({ ok: false, error: "unknown channel" });
		const got = next(socket, "answer.created");
		await realtime.publishTo(survey, {
			orgId: "o1",
			params: { surveyId: "s1" },
			event: "answer.created",
			payload: { answerId: "a1" },
		});
		expect(await got).toEqual({ answerId: "a1" });
		await expect(
			realtime.publishTo(survey, {
				orgId: "o1",
				params: { surveyId: "s1" },
				event: "answer.created",
				payload: { answerId: 1 },
			}),
		).rejects.toThrow();
	});

	it("disconnects a user's sockets when their access changes", async () => {
		const { realtime, url } = await serve();
		const socket = await socketFor(
			url,
			(await realtime.issueTicket({ userId: "u1", orgId: "o1" })).ticket,
		);
		const closed = new Promise((r) => socket.on("disconnect", r));
		await realtime.disconnectUser("o1", "u1");
		await closed;
		expect(socket.connected).toBe(false);
	});

	it("holds the subscription cap under a burst of subscribes", async () => {
		const { realtime, url } = await serve({ maxSubscriptionsPerSocket: 3 });
		const socket = await socketFor(
			url,
			(await realtime.issueTicket({ userId: "u1", orgId: "o1" })).ticket,
		);
		const replies = await Promise.all(
			Array.from({ length: 20 }, (_, i) => socket.emitWithAck("subscribe", `survey.s${i}`)),
		);
		expect(replies.filter((r: { ok: boolean }) => r.ok)).toHaveLength(3);
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

	it("closes a socket after its lifetime, so access is checked again with a new ticket", async () => {
		const { realtime, url } = await serve({ maxSocketLifetimeMs: 200 });
		const socket = await socketFor(
			url,
			(await realtime.issueTicket({ userId: "u1", orgId: "o1" })).ticket,
		);
		await new Promise((r) => socket.on("disconnect", r));
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
		const realtime = createRealtime({
			driver: "socketio",
			adapter: { kind: "memory" },
			tickets: memoryTickets(),
			allowOrigin: () => true,
			logger,
		});
		const server = createServer();
		await realtime.attach(server, { channels: [left, right] });
		await new Promise<void>((r) => server.listen(0, r));
		cleanups.push(() => new Promise((r) => server.close(r)));
		const url = `http://localhost:${(server.address() as AddressInfo).port}`;
		const socket = await socketFor(
			url,
			(await realtime.issueTicket({ userId: "u1", orgId: "o1" })).ticket,
		);
		expect(await socket.emitWithAck("subscribe", "a.b")).toEqual({ ok: true });
		const leaked: unknown[] = [];
		socket.on("e", (p) => leaked.push(p));
		// "a.b" also matches {y}.b, which this socket may not read
		await realtime.publishTo(right, { orgId: "o1", params: { y: "a" }, event: "e", payload: {} });
		await new Promise((r) => setTimeout(r, 200));
		expect(leaked).toEqual([]);
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

	it("logs and drops a publish when Redis ping rejects, never throwing to the caller", async () => {
		const warnings: unknown[] = [];
		const testLogger = pino({
			level: "warn",
			hooks: { logMethod: (args, method) => (warnings.push(args[0]), method.apply(this, args)) },
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
			hooks: { logMethod: (args, method) => (warnings.push(args[0]), method.apply(this, args)) },
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
