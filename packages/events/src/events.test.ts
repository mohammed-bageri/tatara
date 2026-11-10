import { pino } from "pino";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { eventsCommands } from "./commands.ts";
import {
	causedBy,
	createEvents,
	defineEvent,
	defineSubscriber,
	EVENTS_TOPIC,
	type EventsOptions,
	type MemoryTransaction,
	MISSED_BY_DISPATCH,
	memoryEventStore,
	type Subscriber,
	UNKNOWN_SUBSCRIBER_ERROR,
} from "./index.ts";

const logger = pino({ level: "silent" });

const noteCreated = defineEvent({
	name: "notes.note.created",
	aggregateType: "note",
	schema: z.object({ noteId: z.string() }).strict(),
});
const noteArchived = defineEvent({
	name: "notes.note.archived",
	version: 2,
	schema: z.object({ noteId: z.string(), reason: z.enum(["user", "expired"]) }),
});
const definitions = [noteCreated, noteArchived] as const;

/** A clock tests move by hand. */
function clock(start = new Date("2026-06-01T00:00:00Z")) {
	let at = start.getTime();
	return {
		now: () => new Date(at),
		advance: (ms: number) => {
			at += ms;
		},
	};
}

function recorder(name: string, event: string | string[] = noteCreated.name) {
	const seen: string[] = [];
	const control = { fail: 0 };
	const subscriber = defineSubscriber({
		name,
		event,
		async handle(e) {
			if (control.fail-- > 0) throw new Error(`${name} boom`);
			seen.push(e.id);
		},
	});
	return { subscriber, seen, control };
}

function setup(
	subscribers: Subscriber[],
	extra: Partial<EventsOptions<MemoryTransaction | undefined, typeof definitions>> = {},
) {
	const store = memoryEventStore();
	const time = clock();
	const published: { topic: string; data: unknown; orgId?: string | null }[] = [];
	const jobs = {
		enqueue: vi.fn(async (topic: string, data: unknown, opts?: { orgId?: string | null }) => {
			published.push({ topic, data, orgId: opts?.orgId });
			return "job";
		}),
	};
	const events = createEvents({
		store,
		transaction: (fn) => store.transaction(fn),
		events: definitions,
		subscribers,
		jobs: jobs as never,
		logger,
		now: time.now,
		...extra,
	});
	return { store, time, jobs, published, events };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("definitions", () => {
	it("defaults the version to 1 and keeps app fields", () => {
		const def = defineEvent({ name: "a.b.c", schema: z.object({}), labelKey: "x" });
		expect(def.version).toBe(1);
		expect(def.labelKey).toBe("x");
		expectTypeOf(def.name).toEqualTypeOf<"a.b.c">();
	});

	it("rejects a malformed name or version", () => {
		expect(() => defineEvent({ name: "Notes", schema: z.object({}) })).toThrow(/dotted lowercase/);
		expect(() => defineEvent({ name: "a.b", version: 0, schema: z.object({}) })).toThrow(
			/positive integer/,
		);
	});

	it("normalizes a subscriber's events and types its handler", () => {
		const sub = defineSubscriber({
			name: "notes.audit",
			event: [noteCreated, noteArchived, noteCreated],
			async handle(event) {
				if (event.name === "notes.note.archived") {
					expectTypeOf(event.payload.reason).toEqualTypeOf<"user" | "expired">();
				}
			},
		});
		expect(sub.events).toEqual(["notes.note.created", "notes.note.archived"]);
		expect(() => defineSubscriber({ name: "x", event: [], handle: async () => {} })).toThrow(
			/at least one event/,
		);
	});

	it("accepts a custom event name pattern (RegExp)", () => {
		// Three-part pattern: module.aggregate.verb
		const threePartPattern = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/;

		// Valid three-part name
		const validDef = defineEvent(
			{ name: "notes.note.created", schema: z.object({}) },
			threePartPattern,
		);
		expect(validDef.name).toBe("notes.note.created");

		// Invalid two-part name
		expect(() =>
			defineEvent({ name: "note.created", schema: z.object({}) }, threePartPattern),
		).toThrow(/does not match the required pattern/);
	});

	it("accepts a custom event name validator (function)", () => {
		const validator = (name: string) => {
			const parts = name.split(".");
			if (parts.length !== 3) return "Event name must have exactly 3 parts (module.aggregate.verb)";
			return undefined;
		};

		// Valid three-part name
		const validDef = defineEvent({ name: "notes.note.created", schema: z.object({}) }, validator);
		expect(validDef.name).toBe("notes.note.created");

		// Invalid two-part name
		expect(() => defineEvent({ name: "note.created", schema: z.object({}) }, validator)).toThrow(
			/must have exactly 3 parts/,
		);
	});

	it("uses default validation when no custom validator is provided", () => {
		// Valid with default (two or more parts)
		const validDef = defineEvent({ name: "a.b", schema: z.object({}) });
		expect(validDef.name).toBe("a.b");

		// Invalid with default
		expect(() => defineEvent({ name: "NoCaps", schema: z.object({}) })).toThrow(/dotted lowercase/);
	});
});

describe("emit", () => {
	it("writes the event with the transaction, and drops it on rollback", async () => {
		const { store, events } = setup([]);
		await expect(
			store.transaction(async (tx) => {
				await events.emit(tx, noteCreated, { payload: { noteId: "n1" }, orgId: "o1" });
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(store.events).toHaveLength(0);

		const id = await store.transaction((tx) =>
			events.emit(tx, "notes.note.created", {
				payload: { noteId: "n1" },
				orgId: "o1",
				aggregateId: "n1",
				actor: { type: "user", id: "u1" },
			}),
		);
		expect(store.events).toEqual([
			expect.objectContaining({
				id,
				name: "notes.note.created",
				version: 1,
				orgId: "o1",
				aggregateType: "note",
				aggregateId: "n1",
				actor: { type: "user", id: "u1" },
				payload: { noteId: "n1" },
				depth: 0,
				correlationId: null,
				causationId: null,
				publishedAt: null,
			}),
		]);
	});

	it("refuses a payload its schema rejects, and an unknown name", async () => {
		const { events } = setup([]);
		await expect(
			events.emit(undefined, noteCreated, { payload: { noteId: "n", extra: 1 } as never }),
		).rejects.toThrow();
		await expect(
			events.emit(undefined, "notes.missing" as never, { payload: {} as never }),
		).rejects.toThrow(/Unknown event/);
	});

	it("records the cause: causation, correlation and depth", async () => {
		const { store, events } = setup([]);
		const first = await events.emit(undefined, noteCreated, { payload: { noteId: "n" } });
		const firstRecord = await store.findEvent(first);
		const second = await events.emit(undefined, noteArchived, {
			payload: { noteId: "n", reason: "user" },
			cause: causedBy(firstRecord as NonNullable<typeof firstRecord>),
		});
		const secondRecord = await store.findEvent(second);
		const third = await events.emit(undefined, noteArchived, {
			payload: { noteId: "n", reason: "user" },
			cause: causedBy(secondRecord as NonNullable<typeof secondRecord>),
		});
		expect(await store.findEvent(second)).toMatchObject({
			causationId: first,
			correlationId: first,
			depth: 1,
			version: 2,
		});
		expect(await store.findEvent(third)).toMatchObject({
			causationId: second,
			correlationId: first,
			depth: 2,
		});
	});

	it("writes many events of one definition", async () => {
		const { store, events } = setup([]);
		const ids = await events.emitMany(
			undefined,
			noteCreated,
			Array.from({ length: 2500 }, (_, i) => ({ payload: { noteId: `n${i}` } })),
		);
		expect(ids).toHaveLength(2500);
		expect(store.events).toHaveLength(2500);
		expect(await events.emitMany(undefined, noteCreated, [])).toEqual([]);
	});

	it("validates event names at registration with custom pattern", () => {
		const threePartPattern = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/;
		const twoPart = defineEvent({ name: "note.created", schema: z.object({}) });
		const store = memoryEventStore();

		// Should reject events that don't match the custom pattern at registration
		expect(() =>
			createEvents({
				store,
				subscribers: [],
				events: [twoPart] as never,
				logger,
				eventNamePattern: threePartPattern,
			}),
		).toThrow(/does not match the required pattern/);
	});

	it("validates event names at emit with custom validator", async () => {
		const validator = (name: string) => {
			const parts = name.split(".");
			if (parts.length !== 3) return "Event name must have exactly 3 parts";
			return undefined;
		};

		const store = memoryEventStore();
		const events = createEvents({
			store,
			subscribers: [],
			logger,
			eventNamePattern: validator,
		});
		const twoPart = defineEvent({ name: "note.created", schema: z.object({}) });

		// Should reject event definitions at emit that don't match custom validator
		await expect(events.emit(undefined, twoPart, { payload: {} })).rejects.toThrow(
			/must have exactly 3 parts/,
		);
	});
});

describe("events.transaction", () => {
	it("publishes the events it emitted right after commit", async () => {
		const { events, published, store } = setup([]);
		const id = await events.transaction((tx) =>
			events.emit(tx, noteCreated, { payload: { noteId: "n" }, orgId: "o1" }),
		);
		await flush();
		expect(published).toEqual([{ topic: EVENTS_TOPIC, data: { eventId: id }, orgId: "o1" }]);
		expect(store.events[0]?.publishedAt).not.toBeNull();
	});

	it("runs afterCommit hooks once committed, never on rollback; a throwing hook is only logged", async () => {
		const { events } = setup([]);
		expect(events.afterCommit(async () => {})).toBe(false);
		const ran: string[] = [];
		await events.transaction(async () => {
			expect(events.afterCommit(async () => void ran.push("first"))).toBe(true);
			events.afterCommit(async () => {
				throw new Error("hook");
			});
			events.afterCommit(async () => void ran.push("after a failure"));
			expect(ran).toEqual([]);
		});
		expect(ran).toEqual(["first", "after a failure"]);
		await expect(
			events.transaction(async () => {
				events.afterCommit(async () => void ran.push("rolled back"));
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		await events.transaction(async () => {});
		expect(ran).toEqual(["first", "after a failure"]);
	});

	it("needs a transaction opener", async () => {
		const { events } = setup([], { transaction: undefined });
		await expect(events.transaction(async () => 1)).rejects.toThrow(/needs `transaction`/);
	});
});

describe("relay", () => {
	it("publishes events written outside events.transaction, in outbox order", async () => {
		const { events, published } = setup([]);
		const a = await events.emit(undefined, noteCreated, { payload: { noteId: "a" } });
		const b = await events.emit(undefined, noteCreated, { payload: { noteId: "b" } });
		expect(await events.relay()).toBe(2);
		expect(published.map((p) => p.data)).toEqual([{ eventId: a }, { eventId: b }]);
		expect(await events.relay()).toBe(0);
	});

	it("stops at the first failure and leaves the rest for the next sweep", async () => {
		const { events, jobs, store } = setup([]);
		for (const n of ["a", "b", "c"])
			await events.emit(undefined, noteCreated, { payload: { noteId: n } });
		jobs.enqueue.mockImplementationOnce(async () => "ok").mockRejectedValueOnce(new Error("down"));
		expect(await events.relay()).toBe(1);
		expect(store.events.map((e) => e.publishedAt !== null)).toEqual([true, false, false]);
		expect(await events.relay()).toBe(2);
	});

	it("gives up on a hung publish, pauses the fast path, and resumes after a success", async () => {
		const { events, jobs, store, time } = setup([], { publishTimeoutMs: 20 });
		await events.emit(undefined, noteCreated, { payload: { noteId: "a" } });
		jobs.enqueue.mockImplementationOnce(() => new Promise<string>(() => {}));
		expect(await events.relay()).toBe(0);
		expect(events.fastPathEnabled()).toBe(false);

		// paused: the post-commit publish is skipped, the sweep still delivers
		await events.transaction((tx) => events.emit(tx, noteCreated, { payload: { noteId: "b" } }));
		await flush();
		expect(store.events.every((e) => e.publishedAt === null)).toBe(true);
		expect(await events.relay()).toBe(2);
		expect(events.fastPathEnabled()).toBe(true);

		jobs.enqueue.mockImplementationOnce(() => new Promise<string>(() => {}));
		await events.emit(undefined, noteCreated, { payload: { noteId: "c" } });
		await events.relay();
		expect(events.fastPathEnabled()).toBe(false);
		time.advance(30_000);
		expect(events.fastPathEnabled()).toBe(true);
	});

	it("a refused publish does not pause the fast path", async () => {
		const { events, jobs } = setup([]);
		await events.emit(undefined, noteCreated, { payload: { noteId: "a" } });
		jobs.enqueue.mockRejectedValueOnce(new Error("refused"));
		await events.relay();
		expect(events.fastPathEnabled()).toBe(true);
	});

	it("never hands one event to two concurrent relays", async () => {
		const { events, jobs } = setup([]);
		await events.emit(undefined, noteCreated, { payload: { noteId: "a" } });
		let release = () => {};
		jobs.enqueue.mockImplementationOnce(
			() => new Promise<string>((r) => (release = () => r("job"))),
		);
		const first = events.relay();
		expect(await events.relay()).toBe(0);
		release();
		expect(await first).toBe(1);
		expect(jobs.enqueue).toHaveBeenCalledTimes(1);
	});

	it("without jobs, dispatches in its own process", async () => {
		const rec = recorder("notes.audit");
		const { events } = setup([rec.subscriber], { jobs: undefined });
		const id = await events.transaction((tx) =>
			events.emit(tx, noteCreated, { payload: { noteId: "n" } }),
		);
		await vi.waitFor(() => expect(rec.seen).toEqual([id]));
	});
});

describe("dispatch", () => {
	it("runs each matching subscriber once and isolates a failing one", async () => {
		const ok = recorder("notes.ok");
		const failing = recorder("notes.failing");
		const other = recorder("notes.other", noteArchived.name);
		failing.control.fail = 1;
		const { events, store } = setup([ok.subscriber, failing.subscriber, other.subscriber]);
		const id = await events.emit(undefined, noteCreated, { payload: { noteId: "n" } });
		await events.dispatch(id);
		await events.dispatch(id); // a redelivered message runs nobody again
		expect(ok.seen).toEqual([id]);
		expect(failing.seen).toEqual([]);
		expect(other.seen).toEqual([]);
		expect(store.deliveries.map((d) => [d.subscriber, d.status, d.attempts])).toEqual([
			["notes.ok", "done", 1],
			["notes.failing", "failed", 1],
		]);
		expect(store.deliveries[1]?.lastError).toBe("notes.failing boom");
	});

	it("hands the handler the stored record and its attempt", async () => {
		const handle = vi.fn(async () => {});
		const sub = defineSubscriber({ name: "notes.spy", event: noteCreated, handle });
		const { events } = setup([sub]);
		const id = await events.emit(undefined, noteCreated, {
			payload: { noteId: "n" },
			orgId: "o1",
		});
		await events.dispatch(id);
		expect(handle).toHaveBeenCalledWith(
			expect.objectContaining({ id, orgId: "o1", payload: { noteId: "n" } }),
			expect.objectContaining({ attempt: 1 }),
		);
	});

	it("ignores an event that is gone", async () => {
		const { events } = setup([recorder("notes.x").subscriber]);
		await expect(events.dispatch("missing")).resolves.toBeUndefined();
	});

	it("runs as the events.dispatch consumer", async () => {
		const rec = recorder("notes.audit");
		const { events } = setup([rec.subscriber]);
		const id = await events.emit(undefined, noteCreated, { payload: { noteId: "n" } });
		expect(events.consumer.topic).toBe("events.dispatch");
		await events.consumer.handle(events.consumer.schema.parse({ eventId: id }));
		expect(rec.seen).toEqual([id]);
	});
});

describe("retry", () => {
	it("retries only due failures with backoff, and dead-letters after the max attempts", async () => {
		const rec = recorder("notes.flaky");
		rec.control.fail = 100;
		const { events, store, time } = setup([rec.subscriber], { maxAttempts: 3 });
		const id = await events.emit(undefined, noteCreated, { payload: { noteId: "n" } });
		await events.dispatch(id);
		expect(await events.retry()).toBe(0); // due in 30s (2^1 × 15s)
		time.advance(30_000);
		expect(await events.retry()).toBe(1);
		expect(store.deliveries[0]).toMatchObject({ status: "failed", attempts: 2 });
		time.advance(60_000);
		expect(await events.retry()).toBe(1);
		expect(store.deliveries[0]).toMatchObject({ status: "dead", attempts: 3 });
		time.advance(3_600_000);
		expect(await events.retry()).toBe(0);

		rec.control.fail = 0;
		expect(await events.requeueDead({ subscriber: "notes.flaky" })).toBe(1);
		expect(await events.retry()).toBe(1);
		expect(store.deliveries[0]).toMatchObject({ status: "done", attempts: 4 });
		expect(rec.seen).toEqual([id]);
	});

	it("recovers a stale running claim once, and leaves a fresh one alone", async () => {
		const rec = recorder("notes.slow");
		const { events, store, time } = setup([rec.subscriber]);
		const id = await events.emit(undefined, noteCreated, { payload: { noteId: "n" } });
		await store.claimNewDelivery({
			eventId: id,
			subscriber: "notes.slow",
			token: "crashed",
			now: time.now(),
		});
		expect(await events.retry()).toBe(0);
		time.advance(5 * 60_000 + 1);
		expect(await events.retry()).toBe(1);
		expect(await events.retry()).toBe(0);
		expect(rec.seen).toEqual([id]);
		// the crashed runner's late outcome does not overwrite the new one
		await store.settleDelivery(
			{ id: store.deliveries[0]?.id as string, token: "crashed" },
			{ status: "failed", attempts: 9, lastError: "late" },
		);
		expect(store.deliveries[0]).toMatchObject({ status: "done", attempts: 1 });
	});

	it("backs off a delivery whose subscriber this process does not have", async () => {
		const rec = recorder("notes.new");
		const old = setup([], { maxAttempts: 2 });
		const id = await old.events.emit(undefined, noteCreated, { payload: { noteId: "n" } });
		await old.store.createDeliveries([
			{ eventId: id, subscriber: "notes.new", nextAttemptAt: old.time.now(), lastError: "x" },
		]);
		expect(await old.events.retry()).toBe(1);
		expect(old.store.deliveries[0]).toMatchObject({
			status: "failed",
			lastError: UNKNOWN_SUBSCRIBER_ERROR,
		});
		expect(rec.seen).toEqual([]);
	});
});

describe("reconcile", () => {
	it("gives a skipped subscriber one delivery for recent published events, run by the retry sweep", async () => {
		const known = recorder("notes.known");
		const store = memoryEventStore();
		const time = clock();
		const make = (subscribers: Subscriber[]) =>
			createEvents({ store, events: definitions, subscribers, logger, now: time.now });
		const oldWorker = make([known.subscriber]);
		const id = await oldWorker.emit(undefined, noteCreated, { payload: { noteId: "n" } });
		const unpublished = await oldWorker.emit(undefined, noteCreated, {
			payload: { noteId: "later" },
		});
		await oldWorker.relay({ ids: [id] });

		const added = recorder("notes.added");
		const newWorker = make([known.subscriber, added.subscriber]);
		expect(await newWorker.reconcile()).toBe(0); // still within the dispatch grace
		time.advance(2 * 60_000);
		expect(await newWorker.reconcile()).toBe(1);
		expect(await newWorker.reconcile()).toBe(0);
		expect(store.deliveries.find((d) => d.subscriber === "notes.added")).toMatchObject({
			status: "failed",
			lastError: MISSED_BY_DISPATCH,
		});
		await newWorker.retry();
		expect(added.seen).toEqual([id]);
		expect(added.seen).not.toContain(unpublished);

		time.advance(30 * 60_000);
		const late = recorder("notes.late");
		expect(await make([late.subscriber]).reconcile()).toBe(0); // past the lookback
	});
});

describe("prune", () => {
	it("deletes published events past the retention with their deliveries, never unpublished ones", async () => {
		const rec = recorder("notes.audit");
		const { events, store, time } = setup([rec.subscriber]);
		const old = await events.emit(undefined, noteCreated, { payload: { noteId: "old" } });
		const stuck = await events.emit(undefined, noteCreated, { payload: { noteId: "stuck" } });
		await events.relay({ ids: [old] });
		await events.dispatch(old);
		time.advance(400 * 24 * 3_600_000);
		const recent = await events.emit(undefined, noteCreated, { payload: { noteId: "new" } });
		await events.relay({ ids: [recent] });
		expect(await events.prune()).toBe(1);
		expect(store.events.map((e) => e.id).sort()).toEqual([recent, stuck].sort());
		expect(store.deliveries).toEqual([]);
	});
});

describe("createEvents checks", () => {
	it("refuses duplicate event or subscriber names, and a subscriber of an unknown event", async () => {
		expect(() =>
			createEvents({
				store: memoryEventStore(),
				events: [noteCreated, noteCreated],
				subscribers: [],
				logger,
			}),
		).toThrow(/Duplicate event name/);
		const dup = createEvents({
			store: memoryEventStore(),
			subscribers: [recorder("a").subscriber, recorder("a").subscriber],
			logger,
		});
		await expect(dup.dispatch("x")).resolves.toBeUndefined();
		await expect(dup.retry()).rejects.toThrow(/Duplicate event subscriber "a"/);
		const unknown = createEvents({
			store: memoryEventStore(),
			events: definitions,
			subscribers: async () => [recorder("b", "notes.note.deleted").subscriber],
			logger,
		});
		await expect(unknown.reconcile()).rejects.toThrow(/unknown event "notes.note.deleted"/);
	});

	it("types emit by name from the definitions", async () => {
		const { events } = setup([]);
		await events.emit(undefined, "notes.note.archived", {
			payload: { noteId: "n", reason: "user" },
		});
		await expect(
			// @ts-expect-error: reason is "user" or "expired"
			events.emit(undefined, "notes.note.archived", { payload: { noteId: "n", reason: "nope" } }),
		).rejects.toThrow();
	});
});

describe("schedules and commands", () => {
	it("drives the relay, retry, reconcile and prune", async () => {
		const rec = recorder("notes.audit");
		const { events, published } = setup([rec.subscriber]);
		await events.emit(undefined, noteCreated, { payload: { noteId: "n" } });
		const { relay, retry, reconcile, prune } = events.schedules;
		expect([relay.name, retry.name, reconcile.name, prune.name]).toEqual([
			"events-relay",
			"events-retry",
			"events-reconcile",
			"events-prune",
		]);
		await relay.run();
		expect(published).toHaveLength(1);
		await Promise.all([retry.run(), reconcile.run(), prune.run()]);
	});

	it("relays, retries and requeues dead deliveries from the CLI", async () => {
		const { events, store } = setup([]);
		await events.emit(undefined, noteCreated, { payload: { noteId: "n" } });
		const commands = eventsCommands({ events });
		expect(commands.map((c) => c.name)).toEqual([
			"events:relay",
			"events:retry",
			"events:requeue-dead",
		]);
		const ctx = { logger };
		await commands[0]?.run({}, ctx);
		expect(store.events[0]?.publishedAt).not.toBeNull();
		await commands[1]?.run({}, ctx);
		await commands[2]?.run({ subscriber: "x" }, ctx);
	});
});
