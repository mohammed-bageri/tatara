import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { Kafka, logLevel } from "kafkajs";
import pg from "pg";
import { pino } from "pino";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { bullmqDriver } from "./bullmq.ts";
import {
	createJobs,
	defineConsumer,
	defineSchedule,
	InvalidPayloadError,
	inlineDriver,
	type JobDriver,
	jobHandler,
	processJob,
	runSchedule,
	type ScheduleLock,
	startWorker,
	type TopicsOf,
	triggerSchedule,
	UnknownTopicError,
} from "./index.ts";
import { kafkaDriver } from "./kafka.ts";
import { postgresDriver } from "./postgres.ts";

const logger = pino({ level: "silent" });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 15_000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await wait(20);
	}
}

/** A fresh set of consumers that record what they saw. */
function consumers() {
	const seen: { topic: string; data: unknown; orgId: string | null; attempt: number }[] = [];
	const deadLetters: { data: unknown; error: string }[] = [];
	const flaky = { failuresLeft: 0 };
	const list = [
		defineConsumer({
			topic: "notes.created",
			description: "records the note",
			schema: z.object({ noteId: z.string() }),
			async handle(data, ctx) {
				seen.push({ topic: "notes.created", data, orgId: ctx.orgId, attempt: ctx.attempt });
			},
		}),
		defineConsumer({
			topic: "notes.flaky",
			description: "fails a few times first",
			schema: z.object({ n: z.number() }),
			attempts: 3,
			backoffMs: 10,
			async handle(data, ctx) {
				if (flaky.failuresLeft-- > 0) throw new Error(`boom ${ctx.attempt}`);
				seen.push({ topic: "notes.flaky", data, orgId: ctx.orgId, attempt: ctx.attempt });
			},
			async onDeadLetter(data, ctx) {
				deadLetters.push({ data, error: String(ctx.error) });
			},
		}),
	] as const;
	return { list, seen, deadLetters, flaky };
}

const closers: (() => Promise<unknown>)[] = [];
afterAll(async () => {
	for (const close of closers.reverse()) await close().catch(() => {});
}, 60_000);

const REDIS_URL = process.env.TATARA_TEST_REDIS_URL;
const DATABASE_URL = process.env.TATARA_TEST_DATABASE_URL;
const KAFKA_BROKERS = process.env.TATARA_TEST_KAFKA_BROKERS;

let pool: pg.Pool | undefined;
const pgPool = () => {
	pool ??= new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
	closers.push(async () => {
		await pool?.end();
		pool = undefined;
	});
	return pool;
};

type Make = (c: ReturnType<typeof consumers>["list"]) => JobDriver;
const drivers: [string, Make | undefined][] = [
	["inline", (list) => inlineDriver({ consumers: list, logger })],
	[
		"bullmq",
		REDIS_URL
			? () => {
					const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
					closers.push(() => redis.quit());
					return bullmqDriver({
						name: `t-${randomUUID()}`,
						prefix: "tatara-test",
						redis: () => redis,
					});
				}
			: undefined,
	],
	["postgres", DATABASE_URL ? () => postgresDriver({ db: pgPool(), pollMs: 50 }) : undefined],
	[
		"kafka",
		KAFKA_BROKERS
			? () =>
					kafkaDriver({
						kafka: new Kafka({ brokers: KAFKA_BROKERS.split(","), logLevel: logLevel.NOTHING }),
						topic: `t-${randomUUID()}`,
						groupId: `g-${randomUUID()}`,
					})
			: undefined,
	],
];

for (const [name, make] of drivers) {
	// a Kafka consumer takes seconds to join its group
	describe.skipIf(!make)(`the ${name} driver`, { timeout: 60_000 }, () => {
		async function started() {
			const c = consumers();
			const driver = (make as Make)(c.list);
			const stop = await startWorker({ driver, consumers: c.list, concurrency: 4, logger });
			// a worker left running would take the next test's jobs from a shared table
			onTestFinished(stop);
			return { ...c, jobs: createJobs({ driver, consumers: c.list }) };
		}

		it("delivers a job with its payload and org", async () => {
			const { jobs, seen } = await started();
			await jobs.enqueue("notes.created", { noteId: "n1" }, { orgId: "org-1" });
			await until(() => seen.length === 1);
			expect(seen[0]).toEqual({
				topic: "notes.created",
				data: { noteId: "n1" },
				orgId: "org-1",
				attempt: 1,
			});
		});

		it("retries a failing job, then runs it", async () => {
			const { jobs, seen, flaky, deadLetters } = await started();
			flaky.failuresLeft = 2;
			await jobs.enqueue("notes.flaky", { n: 1 });
			await until(() => seen.length === 1);
			expect(seen[0]?.attempt).toBe(3);
			expect(deadLetters).toEqual([]);
		});

		it("calls onDeadLetter once, after the last attempt", async () => {
			const { jobs, flaky, deadLetters, seen } = await started();
			flaky.failuresLeft = 99;
			await jobs.enqueue("notes.flaky", { n: 2 });
			await until(() => deadLetters.length === 1);
			await wait(200);
			expect(deadLetters).toEqual([{ data: { n: 2 }, error: "Error: boom 3" }]);
			expect(seen).toEqual([]);
		});

		it("doesn't let a delayed job hold back one that is due", async () => {
			const { jobs, seen } = await started();
			await jobs.enqueue("notes.created", { noteId: "later" }, { delayMs: 3000 });
			const sent = Date.now();
			await jobs.enqueue("notes.created", { noteId: "now" });
			await until(() => seen.some((s) => (s.data as { noteId: string }).noteId === "now"));
			expect(Date.now() - sent).toBeLessThan(2000);
			await until(() => seen.length === 2);
		});

		it("waits out a delay", async () => {
			const { jobs, seen } = await started();
			const sent = Date.now();
			await jobs.enqueue("notes.created", { noteId: "later" }, { delayMs: 300 });
			await until(() => seen.length === 1);
			expect(Date.now() - sent).toBeGreaterThanOrEqual(290);
		});
	});
}

describe.skipIf(!KAFKA_BROKERS)("the kafka driver with a long delay", { timeout: 60_000 }, () => {
	it("keeps delivering due jobs while a long delay waits", async () => {
		const c = consumers();
		const driver = kafkaDriver({
			kafka: new Kafka({
				brokers: (KAFKA_BROKERS as string).split(","),
				logLevel: logLevel.NOTHING,
			}),
			topic: `t-${randomUUID()}`,
			groupId: `g-${randomUUID()}`,
		});
		const stop = await startWorker({ driver, consumers: c.list, concurrency: 4, logger });
		onTestFinished(stop);
		const jobs = createJobs({ driver, consumers: c.list });
		await jobs.enqueue("notes.created", { noteId: "later" }, { delayMs: 12_000 });
		// longer than kafkajs's own retries take to run out
		await wait(10_000);
		const sent = Date.now();
		await jobs.enqueue("notes.created", { noteId: "now" });
		await until(() => c.seen.some((s) => (s.data as { noteId: string }).noteId === "now"));
		expect(Date.now() - sent).toBeLessThan(3000);
		await until(() => c.seen.length === 2, 20_000);
	});
});

describe.skipIf(!DATABASE_URL)("the postgres driver as an outbox", { timeout: 30_000 }, () => {
	it("stores a job only when the caller's transaction commits", async () => {
		const c = consumers();
		const driver = postgresDriver({ db: pgPool(), pollMs: 50 });
		const jobs = createJobs({ driver, consumers: c.list });
		const stop = await startWorker({ driver, consumers: c.list, concurrency: 2, logger });
		onTestFinished(stop);
		const client = await pgPool().connect();
		try {
			await client.query("begin");
			await jobs.enqueue("notes.created", { noteId: "rolled-back" }, { executor: client });
			await client.query("rollback");
			await client.query("begin");
			await jobs.enqueue("notes.created", { noteId: "committed" }, { executor: client });
			await client.query("commit");
		} finally {
			client.release();
		}
		await until(() => c.seen.length === 1);
		await wait(300);
		expect(c.seen.map((s) => s.data)).toEqual([{ noteId: "committed" }]);
	});
});

describe.skipIf(!DATABASE_URL)("the postgres driver under a slow job", { timeout: 30_000 }, () => {
	it("keeps a job that outlives its visibility timeout to one run", async () => {
		const runs: number[] = [];
		const slow = [
			defineConsumer({
				topic: "slow.job",
				description: "takes longer than the visibility timeout",
				schema: z.object({}),
				async handle() {
					runs.push(Date.now());
					await wait(900);
				},
			}),
		] as const;
		const driver = postgresDriver({ db: pgPool(), pollMs: 50, visibilityMs: 300 });
		const stop = await startWorker({ driver, consumers: slow, concurrency: 4, logger });
		onTestFinished(stop);
		const id = await createJobs({ driver, consumers: slow }).enqueue("slow.job", {});
		await until(() => runs.length === 1);
		await wait(1500);
		expect(runs).toHaveLength(1);
		const left = await pgPool().query("select count(*)::int as n from tatara.jobs where id = $1", [
			id,
		]);
		expect(left.rows[0].n).toBe(0);
	});
});

describe.skipIf(!KAFKA_BROKERS)("the kafka driver with executor", () => {
	it("rejects enqueue with executor parameter", async () => {
		const c = consumers();
		const driver = kafkaDriver({
			kafka: new Kafka({
				brokers: (KAFKA_BROKERS as string).split(","),
				logLevel: logLevel.NOTHING,
			}),
			topic: `t-${randomUUID()}`,
			groupId: `g-${randomUUID()}`,
		});
		const jobs = createJobs({ driver, consumers: c.list });
		await expect(
			jobs.enqueue("notes.created", { noteId: "n1" }, { executor: { fake: "transaction" } }),
		).rejects.toThrow(
			/Kafka driver can't enqueue inside a transaction; use the Postgres driver or enqueue after commit/,
		);
	});
});

describe.skipIf(!REDIS_URL)("the bullmq driver with executor", () => {
	it("rejects enqueue with executor parameter", async () => {
		const c = consumers();
		const redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: null });
		closers.push(() => redis.quit());
		const driver = bullmqDriver({
			name: `t-${randomUUID()}`,
			prefix: "tatara-test",
			redis: () => redis,
		});
		const jobs = createJobs({ driver, consumers: c.list });
		await expect(
			jobs.enqueue("notes.created", { noteId: "n1" }, { executor: { fake: "transaction" } }),
		).rejects.toThrow(
			/BullMQ driver can't enqueue inside a transaction; use the Postgres driver or enqueue after commit/,
		);
	});
});

describe("jobHandler", () => {
	it("gives up on a job whose deliveries ran past its attempts (a worker died on each)", async () => {
		const c = consumers();
		const outcome = await jobHandler(
			c.list,
			logger,
		)({
			id: "lost",
			topic: "notes.created",
			data: { noteId: "x" },
			orgId: null,
			attempt: 4,
			maxAttempts: 3,
			enqueuedAt: new Date().toISOString(),
		});
		expect(outcome.status).toBe("dead");
		expect(c.seen).toEqual([]);
	});
});

describe("createJobs", () => {
	it("rejects a payload or topic its consumers would, before storing anything", async () => {
		const c = consumers();
		const driver = inlineDriver({ consumers: c.list, logger });
		const send = vi.spyOn(driver, "send");
		const jobs = createJobs({ driver, consumers: c.list });
		await expect(jobs.enqueue("notes.created", { noteId: 1 } as never)).rejects.toThrow(
			InvalidPayloadError,
		);
		await expect(jobs.enqueue("nope" as never, {} as never)).rejects.toThrow(UnknownTopicError);
		expect(send).not.toHaveBeenCalled();
	});

	it("types enqueue by the consumers' topics and payloads", async () => {
		const c = consumers();
		const jobs = createJobs<TopicsOf<typeof c.list>>({
			driver: inlineDriver({ consumers: c.list, logger }),
		});
		await jobs.enqueue("notes.created", { noteId: "typed" });
		// @ts-expect-error: noteId is a string
		await jobs.enqueue("notes.created", { noteId: 1 }).catch(() => {});
		// @ts-expect-error: no consumer has this topic
		await jobs.enqueue("notes.deleted", {}).catch(() => {});
	});

	it("dead-letters a stored job whose payload no longer validates, without retrying", async () => {
		const c = consumers();
		const driver = inlineDriver({ consumers: c.list, logger });
		await driver.send([
			{
				job: {
					id: "j1",
					topic: "notes.flaky",
					data: { n: "x" },
					orgId: null,
					attempt: 1,
					maxAttempts: 3,
					enqueuedAt: new Date().toISOString(),
				},
				delayMs: 0,
			},
		]);
		await driver.drain();
		expect(c.deadLetters).toHaveLength(1);
		expect(driver.dead.map((j) => j.attempt)).toEqual([1]);
	});

	it("keeps processJob for tests that call a consumer directly", async () => {
		const c = consumers();
		await processJob(c.list, "notes.created", { noteId: "x" }, { logger, jobId: "t", attempt: 1 });
		expect(c.seen).toHaveLength(1);
		await expect(
			processJob(c.list, "notes.created", {}, { logger, jobId: "t", attempt: 1 }),
		).rejects.toThrow(/Invalid payload/);
	});

	it("rejects duplicate consumers for the same topic in createJobs", () => {
		const duplicate = [
			defineConsumer({
				topic: "same.topic",
				description: "first consumer",
				schema: z.object({}),
				async handle() {},
			}),
			defineConsumer({
				topic: "same.topic",
				description: "second consumer",
				schema: z.object({}),
				async handle() {},
			}),
		];
		expect(() =>
			createJobs({ driver: inlineDriver({ consumers: duplicate, logger }), consumers: duplicate }),
		).toThrow(
			/Duplicate consumers for topic "same\.topic": "first consumer" and "second consumer"/,
		);
	});

	it("rejects duplicate consumers for the same topic in jobHandler", () => {
		const duplicate = [
			defineConsumer({
				topic: "same.topic",
				description: "first consumer",
				schema: z.object({}),
				async handle() {},
			}),
			defineConsumer({
				topic: "same.topic",
				description: "second consumer",
				schema: z.object({}),
				async handle() {},
			}),
		];
		expect(() => jobHandler(duplicate, logger)).toThrow(
			/Duplicate consumers for topic "same\.topic": "first consumer" and "second consumer"/,
		);
	});
});

/** Claims like the cache's add(): a key, once taken, stays taken until its TTL. */
function claimStore(): ScheduleLock {
	const taken = new Set<string>();
	return {
		async add(key) {
			if (taken.has(key)) return false;
			taken.add(key);
			return true;
		},
	};
}

describe("schedules", () => {
	it("runs a tick once however many processes fire it", async () => {
		const run = vi.fn(async () => {});
		const schedule = defineSchedule({ name: "nightly", cron: "0 0 * * *", run });
		const lock = claimStore();
		const tick = new Date("2026-11-01T00:00:00Z");
		const results = await Promise.all(
			[1, 2, 3].map(() => runSchedule(schedule, tick, { lock, logger })),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("runs a tick once even when a late process fires after the first run finished", async () => {
		const run = vi.fn(async () => {});
		const schedule = defineSchedule({ name: "quick", cron: "* * * * *", run });
		const lock = claimStore();
		const tick = new Date("2026-11-01T00:01:00Z");
		expect(await runSchedule(schedule, tick, { lock, logger })).toBe(true);
		// clock skew, or a platform scheduler retrying its HTTP call
		expect(await runSchedule(schedule, tick, { lock, logger })).toBe(false);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("visits every org, and one failing doesn't stop the rest", async () => {
		const visited: string[] = [];
		let result: unknown;
		const schedule = defineSchedule({
			name: "per-org",
			cron: "* * * * *",
			async run({ forEachOrg }) {
				result = await forEachOrg(async (orgId) => {
					if (orgId === "b") throw new Error("bad org");
					visited.push(orgId);
				});
			},
		});
		async function* orgs() {
			yield* ["a", "b", "c"];
		}
		await runSchedule(schedule, new Date(), { lock: claimStore(), logger, orgs });
		expect(visited).toEqual(["a", "c"]);
		expect(result).toEqual({ done: 2, failed: ["b"] });
	});

	it("triggers from outside only with the secret", async () => {
		const run = vi.fn(async () => {});
		const options = {
			schedules: [defineSchedule({ name: "report", cron: "0 * * * *", run })],
			lock: claimStore(),
			logger,
			secret: "s3cret-s3cret",
		};
		expect((await triggerSchedule("report", undefined, options)).status).toBe(401);
		expect((await triggerSchedule("report", "Bearer wrong", options)).status).toBe(401);
		expect((await triggerSchedule("missing", "Bearer s3cret-s3cret", options)).status).toBe(404);
		const ok = await triggerSchedule("report", "Bearer s3cret-s3cret", options);
		expect(ok).toEqual({ status: 200, body: { ran: true } });
		expect(run).toHaveBeenCalledTimes(1);
	});
});
