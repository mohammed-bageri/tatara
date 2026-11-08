import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import {
	bigserial,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import pg from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { drizzleEventStore } from "./drizzle.ts";
import { createEvents, defineEvent, defineSubscriber } from "./index.ts";

// runs against a real Postgres when set (CI, local docker); each run gets its own database
const DATABASE_URL = process.env.TATARA_TEST_DATABASE_URL;
const logger = pino({ level: "silent" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

const events = pgTable("ev_events", {
	id: uuid("id").primaryKey(),
	seq: bigserial("seq", { mode: "number" }).notNull(),
	name: varchar("name", { length: 120 }).notNull(),
	version: integer("version").notNull(),
	orgId: text("org_id"),
	aggregateType: varchar("aggregate_type", { length: 64 }),
	aggregateId: text("aggregate_id"),
	actor: jsonb("actor").notNull(),
	payload: jsonb("payload").notNull(),
	correlationId: uuid("correlation_id"),
	causationId: uuid("causation_id"),
	depth: integer("depth").notNull().default(0),
	occurredAt: ts("occurred_at").notNull().defaultNow(),
	publishedAt: ts("published_at"),
});

const deliveries = pgTable(
	"ev_deliveries",
	{
		id: uuid("id").primaryKey(),
		eventId: uuid("event_id")
			.notNull()
			.references(() => events.id),
		subscriber: varchar("subscriber", { length: 160 }).notNull(),
		status: varchar("status", { length: 16 }).notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
		lastError: text("last_error"),
		createdAt: ts("created_at").notNull().defaultNow(),
		completedAt: ts("completed_at"),
		claimedAt: ts("claimed_at"),
		claimToken: uuid("claim_token"),
	},
	(t) => [uniqueIndex("ev_deliveries_pair").on(t.eventId, t.subscriber)],
);

// tables that predate the package, with Sana's column names
const legacyEvents = pgTable("legacy_events", {
	id: uuid("id").primaryKey(),
	seq: bigserial("seq", { mode: "number" }).notNull(),
	organizationId: text("organization_id").notNull(),
	type: varchar("type", { length: 120 }).notNull(),
	schemaVersion: integer("schema_version").notNull(),
	aggregateType: varchar("aggregate_type", { length: 64 }).notNull(),
	aggregateId: text("aggregate_id").notNull(),
	actor: jsonb("actor").notNull(),
	payload: jsonb("payload").notNull(),
	correlationId: uuid("correlation_id"),
	causationId: uuid("causation_id"),
	depth: integer("depth").notNull().default(0),
	occurredAt: ts("occurred_at").notNull().defaultNow(),
	publishedAt: ts("published_at"),
});
const legacyDeliveries = pgTable(
	"legacy_deliveries",
	{
		id: uuid("id").primaryKey(),
		eventId: uuid("event_id")
			.notNull()
			.references(() => legacyEvents.id, { onDelete: "cascade" }),
		subscriber: varchar("subscriber", { length: 160 }).notNull(),
		status: varchar("status", { length: 16 }).notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
		lastError: text("last_error"),
		createdAt: ts("created_at").notNull().defaultNow(),
		completedAt: ts("completed_at"),
		claimedAt: ts("claimed_at"),
		claimToken: uuid("claim_token"),
	},
	(t) => [uniqueIndex("legacy_deliveries_pair").on(t.eventId, t.subscriber)],
);

const DDL = `
create table ev_events (
	id uuid primary key, seq bigserial not null, name varchar(120) not null, version integer not null,
	org_id text, aggregate_type varchar(64), aggregate_id text, actor jsonb not null, payload jsonb not null,
	correlation_id uuid, causation_id uuid, depth integer not null default 0,
	occurred_at timestamptz not null default now(), published_at timestamptz);
create table ev_deliveries (
	id uuid primary key, event_id uuid not null references ev_events(id), subscriber varchar(160) not null,
	status varchar(16) not null default 'pending', attempts integer not null default 0,
	next_attempt_at timestamptz not null default now(), last_error text,
	created_at timestamptz not null default now(), completed_at timestamptz, claimed_at timestamptz,
	claim_token uuid);
create unique index ev_deliveries_pair on ev_deliveries (event_id, subscriber);
create table legacy_events (
	id uuid primary key, seq bigserial not null, organization_id text not null, type varchar(120) not null,
	schema_version integer not null, aggregate_type varchar(64) not null, aggregate_id text not null,
	actor jsonb not null, payload jsonb not null, correlation_id uuid, causation_id uuid,
	depth integer not null default 0, occurred_at timestamptz not null default now(), published_at timestamptz);
create table legacy_deliveries (
	id uuid primary key, event_id uuid not null references legacy_events(id) on delete cascade,
	subscriber varchar(160) not null, status varchar(16) not null default 'pending',
	attempts integer not null default 0, next_attempt_at timestamptz not null default now(), last_error text,
	created_at timestamptz not null default now(), completed_at timestamptz, claimed_at timestamptz,
	claim_token uuid);
create unique index legacy_deliveries_pair on legacy_deliveries (event_id, subscriber);
`;

const noteCreated = defineEvent({
	name: "notes.note.created",
	aggregateType: "note",
	schema: z.object({ noteId: z.string() }),
});

describe.skipIf(!DATABASE_URL)("the Drizzle Postgres store", () => {
	const name = `tatara_events_${randomUUID().replaceAll("-", "")}`;
	let admin: pg.Pool;
	let pool: pg.Pool;
	let db: ReturnType<typeof drizzle>;
	type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

	beforeAll(async () => {
		admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
		await admin.query(`create database ${name}`);
		const url = new URL(DATABASE_URL as string);
		url.pathname = `/${name}`;
		pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
		await pool.query(DDL);
		db = drizzle({ client: pool });
	});

	afterAll(async () => {
		await pool?.end();
		await admin?.query(`drop database if exists ${name} with (force)`);
		await admin?.end();
	});

	function setup(store = drizzleEventStore<Executor>(db, { events, deliveries })) {
		const seen: string[] = [];
		const control = { fail: 0 };
		const published: string[] = [];
		const jobs = {
			async enqueue(_topic: string, data: { eventId: string }) {
				published.push(data.eventId);
				return "job";
			},
		};
		const ev = createEvents({
			store,
			transaction: (fn) => db.transaction(fn),
			events: [noteCreated],
			subscribers: [
				defineSubscriber({
					name: "notes.audit",
					event: noteCreated,
					async handle(e) {
						if (control.fail-- > 0) throw new Error("boom");
						seen.push(e.payload.noteId);
					},
				}),
			],
			jobs: jobs as never,
			logger,
			backoffMs: () => 0,
		});
		return { ev, seen, control, published };
	}

	it("writes events with the caller's transaction, relays and dispatches them", async () => {
		const { ev, seen, published } = setup();
		await expect(
			db.transaction(async (tx) => {
				await ev.emit(tx, noteCreated, { payload: { noteId: "gone" }, orgId: "o1" });
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		const id = await db.transaction((tx) =>
			ev.emit(tx, noteCreated, {
				payload: { noteId: "n1" },
				orgId: "o1",
				aggregateId: "n1",
				actor: { type: "user", id: "u1" },
			}),
		);
		expect(await ev.relay()).toBe(1);
		expect(published).toEqual([id]);
		expect(await ev.relay()).toBe(0);
		await ev.dispatch(id);
		await ev.dispatch(id);
		expect(seen).toEqual(["n1"]);
		const [row] = await db.select().from(deliveries);
		expect(row).toMatchObject({ status: "done", attempts: 1, claimToken: null });
	});

	it("publishes right after an events.transaction commits", async () => {
		const { ev, published } = setup();
		const id = await ev.transaction((tx) => ev.emit(tx, noteCreated, { payload: { noteId: "n" } }));
		await expect.poll(() => published).toEqual([id]);
	});

	it("never hands one event to two concurrent relays (SKIP LOCKED)", async () => {
		const first = setup();
		await first.ev.emitMany(
			db,
			noteCreated,
			Array.from({ length: 20 }, (_, i) => ({ payload: { noteId: `c${i}` } })),
		);
		const counts = await Promise.all([first.ev.relay(), first.ev.relay(), first.ev.relay()]);
		expect(counts.reduce((a, b) => a + b, 0)).toBe(20);
		expect(new Set(first.published).size).toBe(20);
		expect(first.published).toHaveLength(20);
	});

	it("retries a failure, reconciles a skipped subscriber, requeues dead and prunes", async () => {
		const { ev, seen, control } = setup();
		control.fail = 1;
		const id = await ev.emit(db, noteCreated, { payload: { noteId: "r" } });
		await ev.relay();
		await ev.dispatch(id);
		expect(seen).not.toContain("r");
		expect(await ev.retry()).toBeGreaterThanOrEqual(1);
		expect(seen).toContain("r");

		// a subscriber the dispatcher did not know: its delivery appears once the grace has passed
		const late: string[] = [];
		const store = drizzleEventStore<Executor>(db, { events, deliveries });
		const later = createEvents({
			store,
			subscribers: [
				defineSubscriber({
					name: "notes.late",
					event: noteCreated,
					async handle(e) {
						late.push(e.id);
					},
				}),
			],
			logger,
			reconcileGraceMs: 0,
			maxAttempts: 1,
		});
		expect(await later.reconcile()).toBeGreaterThanOrEqual(1);
		expect(await later.reconcile()).toBe(0);
		await later.retry({ limit: 1000 });
		expect(late).toContain(id);

		await db.update(deliveries).set({ status: "dead" });
		expect(await later.requeueDead({ subscriber: "notes.late" })).toBeGreaterThanOrEqual(1);

		const future = createEvents({
			store,
			subscribers: [],
			logger,
			now: () => new Date(Date.now() + 400 * 24 * 3_600_000),
		});
		const unpublished = await ev.emit(db, noteCreated, { payload: { noteId: "u" } });
		expect(await future.prune()).toBeGreaterThanOrEqual(1);
		const left = await db.select({ id: events.id }).from(events);
		expect(left.map((r) => r.id)).toEqual([unpublished]);
		expect(await db.select().from(deliveries)).toEqual([]);
	});

	it("without jobs, the relay dispatches in its own process without waiting on its own lock", async () => {
		const seen: string[] = [];
		const ev = createEvents({
			store: drizzleEventStore<Executor>(db, { events, deliveries }),
			subscribers: [
				defineSubscriber({
					name: "notes.inline",
					event: noteCreated,
					async handle(e) {
						seen.push(e.id);
					},
				}),
			],
			logger,
		});
		const id = await ev.emit(db, noteCreated, { payload: { noteId: "inline" } });
		expect(await ev.relay({ ids: [id] })).toBe(1);
		expect(seen).toEqual([id]);
	});

	it("works over tables with other column names", async () => {
		const store = drizzleEventStore<Executor>(
			db,
			{ events: legacyEvents, deliveries: legacyDeliveries },
			{ columns: { orgId: "organizationId", name: "type", version: "schemaVersion" } },
		);
		const { ev, seen } = setup(store);
		const id = await ev.emit(db, noteCreated, {
			payload: { noteId: "legacy" },
			orgId: "o1",
			aggregateId: "n",
		});
		await ev.relay();
		await ev.dispatch(id);
		expect(seen).toEqual(["legacy"]);
		const [row] = await db.select().from(legacyEvents);
		expect(row).toMatchObject({
			organizationId: "o1",
			type: "notes.note.created",
			schemaVersion: 1,
		});
		expect(() => drizzleEventStore(db, { events: legacyEvents, deliveries })).toThrow(
			/no "name" column/,
		);
	});
});
