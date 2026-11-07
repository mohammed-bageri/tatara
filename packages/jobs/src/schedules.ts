import { createHash, timingSafeEqual } from "node:crypto";
import { type CoreLogger, onShutdown } from "@tatara/core";
import { Cron } from "croner";
import type { ScheduleContext, ScheduleDefinition } from "./define.ts";

/** What schedules claim ticks with; `cache` from `@tatara/cache` is one (its `add` and `lock`). */
export interface ScheduleLock {
	/** true only for the first caller with this key until the TTL passes */
	add(key: string, value: string, options: { ttlMs: number }): Promise<boolean>;
	/** runs `fn` only while holding the lock; with it, a run still going skips the next tick */
	lock?<T>(
		key: string,
		ttlMs: number,
		fn: () => Promise<T>,
		options?: { renew?: boolean },
	): Promise<{ acquired: true; value: T } | { acquired: false }>;
}

export interface ScheduleRunOptions {
	lock: ScheduleLock;
	logger: CoreLogger;
	/** the orgs `forEachOrg` visits; without it, `forEachOrg` visits none */
	orgs?: () => AsyncIterable<string> | Iterable<string> | Promise<Iterable<string>>;
}

function context(log: CoreLogger, options: ScheduleRunOptions): ScheduleContext {
	return {
		logger: log,
		async forEachOrg(fn) {
			let done = 0;
			const failed: string[] = [];
			for await (const orgId of (await options.orgs?.()) ?? []) {
				try {
					await fn(orgId);
					done++;
				} catch (err) {
					failed.push(orgId);
					log.error({ err, orgId }, "schedule failed for an org");
				}
			}
			return { done, failed };
		},
	};
}

/**
 * Runs one schedule for one tick. The tick is claimed, not locked: the claim outlives the run, so a
 * cron process with a skewed clock or a retried trigger for the same tick doesn't run it again.
 * With a lock that can hold (`lock`), the run also holds a renewed lock on the schedule, so a run
 * that outlasts its interval makes the next tick skip instead of overlapping it on another
 * process. Returns false when the tick was already claimed or the previous run is still going.
 */
export async function runSchedule(
	schedule: ScheduleDefinition,
	tick: Date,
	options: ScheduleRunOptions,
): Promise<boolean> {
	const log = options.logger.child({ schedule: schedule.name });
	const key = `schedule:${schedule.name}:${tick.toISOString()}`;
	const ttlMs = schedule.lockTtlMs ?? 60 * 60 * 1000;
	const claimed = await options.lock.add(key, `${process.pid}`, { ttlMs });
	if (!claimed) {
		log.debug("skipped: this tick ran elsewhere");
		return false;
	}
	const run = () => schedule.run(context(log, options));
	if (!options.lock.lock) {
		await run();
		return true;
	}
	const held = await options.lock.lock(`schedule:${schedule.name}:running`, ttlMs, run, {
		renew: true,
	});
	if (!held.acquired) {
		log.info("skipped: the previous run is still going");
		return false;
	}
	return true;
}

/** Runs each schedule in UTC in this process (the `apps/cron` way). */
export function startCron(
	options: ScheduleRunOptions & { schedules: ScheduleDefinition[] },
): Cron[] {
	const jobs = options.schedules.map(
		(schedule) =>
			new Cron(
				schedule.cron,
				{ timezone: "UTC", protect: true, name: schedule.name },
				async (self: Cron) => {
					await runSchedule(schedule, self.currentRun() ?? new Date(), options).catch(
						(err: unknown) =>
							options.logger.error({ err, schedule: schedule.name }, "schedule failed"),
					);
				},
			),
	);
	onShutdown("cron", () => {
		for (const job of jobs) job.stop();
	});
	options.logger.info(
		{ schedules: options.schedules.map((s) => `${s.name} (${s.cron})`) },
		"cron started",
	);
	return jobs;
}

/** The current minute: external triggers for the same minute share one lock with each other. */
export function triggerTick(now = new Date()): Date {
	const tick = new Date(now);
	tick.setUTCSeconds(0, 0);
	return tick;
}

const digest = (text: string) => createHash("sha256").update(text).digest();

/**
 * An HTTP trigger for platform schedulers (Cloud Scheduler, EventBridge, a k8s CronJob): checks
 * `Authorization: Bearer <secret>` and runs the schedule under the minute's lock.
 */
export async function triggerSchedule(
	name: string,
	authorization: string | undefined,
	options: ScheduleRunOptions & { schedules: ScheduleDefinition[]; secret: string },
): Promise<{ status: 200 | 401 | 404; body: { ran?: boolean; error?: string } }> {
	const given = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
	if (!options.secret || !timingSafeEqual(digest(given), digest(options.secret)))
		return { status: 401, body: { error: "Unauthorized" } };
	const schedule = options.schedules.find((s) => s.name === name);
	if (!schedule) return { status: 404, body: { error: `No schedule named "${name}"` } };
	return { status: 200, body: { ran: await runSchedule(schedule, triggerTick(), options) } };
}
