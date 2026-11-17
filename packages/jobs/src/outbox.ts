import { randomUUID } from "node:crypto";
import { type CoreLogger, onShutdown } from "@tatara/core";
import type { JobEnvelope } from "./define.ts";
import type { Outgoing } from "./driver.ts";
import type { Queryable } from "./postgres.ts";

/**
 * A transactional outbox in Postgres for drivers that can't write in the caller's transaction
 * (BullMQ, Kafka, inline). `enqueue(…, { executor: inTransaction(tx) })` writes the job as a row in
 * `tx`; once it commits, the row is forwarded to the driver and deleted. A rollback leaves nothing.
 */
export interface JobOutboxOptions {
	/** a pool: forwarding reads and deletes rows outside any caller's transaction */
	db: Queryable;
	logger: CoreLogger;
	/** how often committed rows are forwarded (default 200ms) */
	pollMs?: number;
	/**
	 * How long a process that is not a worker keeps forwarding after its last transactional enqueue
	 * (default 10s); a worker forwards every committed row for as long as it runs.
	 */
	fastPathMs?: number;
}

// next to tatara.jobs: ORM migrations and the test reset look at "public" and never see it
const TABLE = "tatara.job_outbox";

export const TRANSACTION_ERROR =
	"can't enqueue inside a transaction; use the Postgres driver or enqueue after commit, or give the driver an `outbox`";
const BATCH = 100;
const CLAIM_MS = 60_000;

export interface JobOutbox {
	/** Writes the jobs in the caller's transaction, then forwards them soon after commit. */
	write(jobs: Outgoing[], executor: Queryable): Promise<void>;
	/** Forwards every committed row now; returns how many. */
	forward(): Promise<number>;
	/** Forwards every `pollMs` until the returned function is called (the worker). */
	run(): () => Promise<void>;
}

/**
 * `queue` names where the rows go (a BullMQ queue, a Kafka topic): a process forwards only its own
 * queue's rows, so queues and apps can share one database.
 */
export function jobOutbox(
	options: JobOutboxOptions,
	queue: string,
	send: (jobs: Outgoing[]) => Promise<void>,
): JobOutbox {
	const { db, logger } = options;
	const pollMs = options.pollMs ?? 200;
	const fastPathMs = options.fastPathMs ?? 10_000;

	let ready: Promise<void> | undefined;
	const ensure = () => {
		ready ??= (async () => {
			try {
				await db.query("create schema if not exists tatara");
				await db.query(`create table if not exists ${TABLE} (
					id text primary key,
					queue text not null,
					job jsonb not null,
					not_before timestamptz not null,
					created_at timestamptz not null default now(),
					locked_until timestamptz,
					claim_token text
				)`);
				await db.query(
					`create index if not exists job_outbox_queue on ${TABLE} (queue, created_at)`,
				);
			} catch (error) {
				// another process created it first: "if not exists" still races on the catalog
				if (!["23505", "42P06", "42P07"].includes((error as { code?: string }).code ?? "")) {
					ready = undefined;
					throw error;
				}
			}
		})();
		return ready;
	};

	const forwardBatch = async (): Promise<number> => {
		const token = randomUUID();
		const claimed = (await db.query(
			`with due as (
				select id from ${TABLE}
				where queue = $4 and (locked_until is null or locked_until < now())
				order by created_at limit $1 for update skip locked
			)
			update ${TABLE} o set locked_until = now() + $2::bigint * interval '1 millisecond', claim_token = $3
			from due where o.id = due.id
			returning o.job, greatest(0, ceil(extract(epoch from (o.not_before - now())) * 1000))::bigint::text as delay_ms`,
			[BATCH, CLAIM_MS, token, queue],
		)) as { rows?: { job: JobEnvelope; delay_ms: string }[] };
		const rows = claimed.rows ?? [];
		if (rows.length === 0) return 0;
		try {
			await send(rows.map((row) => ({ job: row.job, delayMs: Number(row.delay_ms) })));
		} catch (error) {
			await db
				.query(
					`update ${TABLE} set locked_until = null, claim_token = null where claim_token = $1`,
					[token],
				)
				.catch(() => {});
			throw error;
		}
		// a crash before this sends the jobs again once the claim lapses: at least once, like retries
		await db.query(`delete from ${TABLE} where claim_token = $1`, [token]);
		return rows.length;
	};

	// one forward at a time per process, so drain() and the loop never claim the same batch twice
	let chain: Promise<unknown> = Promise.resolve();
	const forward = (): Promise<number> => {
		const next = chain.then(async () => {
			await ensure();
			let total = 0;
			for (;;) {
				const n = await forwardBatch();
				total += n;
				if (n < BATCH) return total;
			}
		});
		chain = next.catch(() => {});
		return next;
	};

	let workers = 0;
	let fastPathUntil = 0;
	let stopped = false;
	let loop: Promise<void> | undefined;
	let wake: (() => void) | undefined;
	let shutdownRegistered = false;
	const active = () => !stopped && (workers > 0 || Date.now() < fastPathUntil);
	const start = () => {
		if (loop || !active()) return;
		if (!shutdownRegistered) {
			shutdownRegistered = true;
			onShutdown("jobs-outbox", async () => {
				stopped = true;
				wake?.();
				await loop;
			});
		}
		loop = (async () => {
			while (active()) {
				try {
					await forward();
				} catch (err) {
					logger.warn({ err }, "could not forward outbox jobs; retrying");
				}
				if (!active()) break;
				await new Promise<void>((resolve) => {
					wake = resolve;
					setTimeout(resolve, pollMs).unref();
				});
			}
		})().finally(() => {
			loop = undefined;
			// a write that landed while the loop was exiting
			start();
		});
	};

	return {
		async write(jobs, executor) {
			if (jobs.length === 0) return;
			await ensure();
			const values: unknown[] = [];
			const rows = jobs.map(({ job, delayMs }) => {
				const at = values.length;
				// "-" like BullMQ job ids, which may not contain ":"
				values.push(`${job.id}-${job.attempt}`, queue, JSON.stringify(job), delayMs);
				return `($${at + 1}, $${at + 2}, $${at + 3}::jsonb, now() + $${at + 4}::bigint * interval '1 millisecond')`;
			});
			await executor.query(
				`insert into ${TABLE} (id, queue, job, not_before) values ${rows.join(", ")}`,
				values,
			);
			fastPathUntil = Date.now() + fastPathMs;
			start();
		},
		forward,
		run() {
			workers++;
			start();
			return async () => {
				workers--;
				if (active()) return;
				wake?.();
				await loop;
			};
		},
	};
}
