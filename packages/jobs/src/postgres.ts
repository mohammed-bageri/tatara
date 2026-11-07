import type { JobEnvelope } from "./define.ts";
import type { JobDriver } from "./driver.ts";

/** Anything with pg's `query`: a `pg.Pool`, or the caller's transaction wrapped to look like one. */
export interface Queryable {
	query(text: string, values?: unknown[]): Promise<{ rows?: Record<string, unknown>[] } | unknown>;
}

export interface PostgresDriverOptions {
	/** a pool for the worker and for jobs sent outside a transaction */
	db: Queryable;
	/** how often an idle worker looks for due jobs (default 500ms) */
	pollMs?: number;
	/** how long a claimed job stays hidden from other workers; a worker that dies frees it after (default 5 min) */
	visibilityMs?: number;
}

// its own schema: ORM migrations and the test reset look at "public" and never see it
const TABLE = "tatara.jobs";

interface Row {
	id: string;
	topic: string;
	data: unknown;
	org_id: string | null;
	request_id: string | null;
	attempt: number;
	max_attempts: number;
	enqueued_at: Date | string;
	claim_token: string;
}

const toJob = (row: Row): JobEnvelope => ({
	id: row.id,
	topic: row.topic,
	data: row.data,
	orgId: row.org_id,
	requestId: row.request_id,
	attempt: row.attempt,
	maxAttempts: row.max_attempts,
	enqueuedAt: new Date(row.enqueued_at).toISOString(),
});

const rowsOf = (result: unknown) => ((result as { rows?: Row[] }).rows ?? []) as Row[];

/**
 * Jobs in a Postgres table claimed with SKIP LOCKED. Sent with the caller's transaction as
 * `executor`, a job is a transactional outbox entry: it exists exactly when the caller's writes do.
 * Dead jobs stay in the table (`dead_at`, `last_error`) until someone deletes them.
 */
export function postgresDriver(options: PostgresDriverOptions): JobDriver {
	const { db } = options;
	let ready: Promise<void> | undefined;
	const ensure = () => {
		ready ??= (async () => {
			try {
				await db.query("create schema if not exists tatara");
				await db.query(`create table if not exists ${TABLE} (
					id text primary key,
					topic text not null,
					data jsonb not null,
					org_id text,
					request_id text,
					attempt integer not null,
					max_attempts integer not null,
					enqueued_at timestamptz not null,
					run_at timestamptz not null,
					locked_until timestamptz,
					claim_token text,
					dead_at timestamptz,
					last_error text
				)`);
				await db.query(`alter table ${TABLE} add column if not exists claim_token text`);
				await db.query(`alter table ${TABLE} add column if not exists request_id text`);
				await db.query(
					`create index if not exists jobs_due on ${TABLE} (run_at) where dead_at is null`,
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

	return {
		name: "postgres",
		async send(jobs, executor) {
			if (jobs.length === 0) return;
			await ensure();
			const values: unknown[] = [];
			const rows = jobs.map(({ job, delayMs }) => {
				const at = values.length;
				values.push(
					job.id,
					job.topic,
					JSON.stringify(job.data),
					job.orgId,
					job.requestId ?? null,
					job.attempt,
					job.maxAttempts,
					job.enqueuedAt,
					delayMs,
				);
				const p = (n: number) => `$${at + n}`;
				return `(${p(1)}, ${p(2)}, ${p(3)}::jsonb, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}::timestamptz, now() + ${p(9)}::bigint * interval '1 millisecond')`;
			});
			await ((executor as Queryable | undefined) ?? db).query(
				`insert into ${TABLE} (id, topic, data, org_id, request_id, attempt, max_attempts, enqueued_at, run_at) values ${rows.join(", ")}`,
				values,
			);
		},
		async consume(handle, { concurrency, logger }) {
			await ensure();
			const pollMs = options.pollMs ?? 500;
			const visibilityMs = options.visibilityMs ?? 5 * 60 * 1000;
			const inFlight = new Set<Promise<void>>();
			let running = true;
			let wake: (() => void) | undefined;

			// every write after the claim names it: a worker whose claim lapsed and was retaken changes nothing
			const settle = async (job: JobEnvelope, token: string) => {
				const renew = setInterval(
					() => {
						db.query(
							`update ${TABLE} set locked_until = now() + $3::bigint * interval '1 millisecond' where id = $1 and claim_token = $2`,
							[job.id, token, visibilityMs],
						).catch((err: unknown) =>
							logger.warn({ err, jobId: job.id }, "could not extend a job's claim"),
						);
					},
					Math.max(50, Math.floor(visibilityMs / 3)),
				);
				let outcome: Awaited<ReturnType<typeof handle>>;
				try {
					outcome = await handle(job);
				} finally {
					clearInterval(renew);
				}
				if (outcome.status === "done")
					await db.query(`delete from ${TABLE} where id = $1 and claim_token = $2`, [
						job.id,
						token,
					]);
				else if (outcome.status === "retry")
					await db.query(
						`update ${TABLE} set attempt = attempt + 1, run_at = now() + $3::bigint * interval '1 millisecond', locked_until = null, claim_token = null, last_error = $4 where id = $1 and claim_token = $2`,
						[job.id, token, outcome.delayMs, String(outcome.error)],
					);
				else
					await db.query(
						`update ${TABLE} set dead_at = now(), locked_until = null, claim_token = null, last_error = $3 where id = $1 and claim_token = $2`,
						[job.id, token, String(outcome.error)],
					);
			};

			const loop = (async () => {
				while (running) {
					const free = concurrency - inFlight.size;
					let claimed: Row[] = [];
					if (free > 0) {
						try {
							claimed = rowsOf(
								await db.query(
									`with due as (
										select id from ${TABLE}
										where dead_at is null and run_at <= now() and (locked_until is null or locked_until < now())
										order by run_at limit $1 for update skip locked
									)
									update ${TABLE} j set
										locked_until = now() + $2::bigint * interval '1 millisecond',
										claim_token = gen_random_uuid()::text,
										-- an earlier claim lapsed: its worker died mid-run, which uses up an attempt
										attempt = case when j.claim_token is null then j.attempt else j.attempt + 1 end
									from due where j.id = due.id
									returning j.*`,
									[free, visibilityMs],
								),
							);
						} catch (err) {
							logger.error({ err }, "could not claim jobs");
						}
					}
					for (const row of claimed) {
						const run = settle(toJob(row), row.claim_token)
							.catch((err) =>
								logger.error({ err, jobId: row.id }, "could not record a job's outcome"),
							)
							.finally(() => {
								inFlight.delete(run);
								wake?.();
							});
						inFlight.add(run);
					}
					// a full batch means more may be due: look again at once
					if (claimed.length === 0 || claimed.length < free)
						await new Promise<void>((resolve) => {
							wake = resolve;
							setTimeout(resolve, pollMs);
						});
				}
			})();

			return async () => {
				running = false;
				wake?.();
				await loop;
				await Promise.all([...inFlight]);
			};
		},
	};
}
