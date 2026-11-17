import { createEvents, defineEvent, defineSubscriber, memoryEventStore } from "@tatara/events";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deliverEvents } from "./index.ts";

const logger = pino({ level: "silent" });

const placed = defineEvent({ name: "orders.order.placed", schema: z.object({ n: z.number() }) });
const shipped = defineEvent({ name: "orders.order.shipped", schema: z.object({ n: z.number() }) });

/** Jobs that run on a later tick, like the InlineDriver: enqueue resolves before the job runs. */
function laterJobs() {
	const pending = new Set<Promise<void>>();
	let run: (topic: string, data: unknown) => Promise<void> = async () => {};
	return {
		jobs: {
			async enqueue(topic: string, data: unknown) {
				const job = new Promise<void>((resolve) =>
					setTimeout(() => void run(topic, data).finally(resolve), 5),
				);
				pending.add(job);
				void job.finally(() => pending.delete(job));
				return "job";
			},
		},
		setRunner(fn: typeof run) {
			run = fn;
		},
		async drain() {
			while (pending.size > 0) await Promise.all([...pending]);
		},
	};
}

describe("deliverEvents", () => {
	it("delivers committed events and the events their subscribers emit, through jobs", async () => {
		const store = memoryEventStore();
		const seen: string[] = [];
		const queue = laterJobs();
		const events = createEvents({
			store,
			transaction: (fn) => store.transaction(fn),
			events: [placed, shipped],
			subscribers: [
				defineSubscriber({
					name: "orders.ship",
					event: placed.name,
					async handle(e) {
						seen.push(`placed ${(e.payload as { n: number }).n}`);
						await events.transaction((tx) =>
							events.emit(tx, shipped, { payload: e.payload as { n: number } }),
						);
					},
				}),
				defineSubscriber({
					name: "orders.notify",
					event: shipped.name,
					async handle(e) {
						seen.push(`shipped ${(e.payload as { n: number }).n}`);
					},
				}),
			],
			jobs: queue.jobs as never,
			logger,
		});
		queue.setRunner((_, data) => events.consumer.handle(data as { eventId: string }));

		await events.transaction((tx) => events.emit(tx, placed, { payload: { n: 1 } }));
		// outside events.transaction: only the relay publishes it
		await events.emit(undefined, placed, { payload: { n: 2 } });
		await deliverEvents({ events, drain: () => queue.drain() });

		expect(seen.sort()).toEqual(["placed 1", "placed 2", "shipped 1", "shipped 2"]);
		expect(store.events.every((e) => e.publishedAt !== null)).toBe(true);
	});

	it("gives up when events keep arriving", async () => {
		const forever = { flush: async () => 1, relay: async () => 0 };
		await expect(deliverEvents({ events: forever, maxRounds: 3 })).rejects.toThrow(/3 rounds/);
	});
});
