import { onShutdown } from "@tatara/core";
import type { Kafka, Producer } from "kafkajs";
import type { JobEnvelope } from "./define.ts";
import type { JobDriver, Outgoing } from "./driver.ts";

export interface KafkaDriverOptions {
	kafka: Kafka;
	/** the app's job topic; retries wait in `<topic>.delayed`, dead jobs land in `<topic>.dead` */
	topic: string;
	/** one consumer group per app, so every job runs once across its workers */
	groupId: string;
}

const NOT_BEFORE = "tatara-not-before";

/**
 * Jobs on Kafka: one topic per app, keyed by org so an org's jobs keep their order. Delayed jobs
 * (retries, `delayMs`) wait in `<topic>.delayed` under their own consumer group and move to the main
 * topic when due, so they never hold up due jobs. Delays are at least what was asked: a long one
 * holds back shorter delays queued behind it on the same partition.
 */
export function kafkaDriver(options: KafkaDriverOptions): JobDriver {
	const delayed = `${options.topic}.delayed`;
	const dead = `${options.topic}.dead`;
	let producer: Promise<Producer> | undefined;
	let topics: Promise<void> | undefined;

	const ensureTopics = () => {
		topics ??= (async () => {
			const admin = options.kafka.admin();
			await admin.connect();
			try {
				await admin.createTopics({
					topics: [options.topic, delayed, dead].map((topic) => ({ topic })),
					waitForLeaders: true,
				});
			} finally {
				await admin.disconnect();
			}
		})().catch((error) => {
			topics = undefined;
			throw error;
		});
		return topics;
	};
	const connected = () => {
		producer ??= (async () => {
			await ensureTopics();
			const p = options.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
			await p.connect();
			onShutdown("kafka-producer", () => p.disconnect());
			return p;
		})().catch((error) => {
			producer = undefined;
			throw error;
		});
		return producer;
	};
	const produce = async (topic: string, jobs: Outgoing[], extra: Record<string, string> = {}) => {
		await (await connected()).send({
			topic,
			messages: jobs.map(({ job, delayMs }) => ({
				key: job.orgId ?? job.id,
				value: JSON.stringify(job),
				headers: { [NOT_BEFORE]: String(Date.now() + delayMs), ...extra },
			})),
		});
	};

	return {
		name: "kafka",
		async send(jobs, executor) {
			if (executor !== undefined) {
				throw new Error(
					"Kafka driver can't enqueue inside a transaction; use the Postgres driver or enqueue after commit",
				);
			}
			const now = jobs.filter((j) => j.delayMs <= 0);
			const later = jobs.filter((j) => j.delayMs > 0);
			if (now.length) await produce(options.topic, now);
			if (later.length) await produce(delayed, later);
		},
		async consume(handle, { concurrency, logger }) {
			await ensureTopics();
			// delayed jobs wait in their own group, so a long delay never holds up jobs that are due
			const waiter = options.kafka.consumer({ groupId: `${options.groupId}.delayed` });
			await waiter.connect();
			await waiter.subscribe({ topics: [delayed] });
			let running = true;
			await waiter.run({
				eachMessage: async ({ message, heartbeat }) => {
					const notBefore = Number(message.headers?.[NOT_BEFORE]?.toString() ?? 0);
					while (running && Date.now() < notBefore) {
						await new Promise((r) => setTimeout(r, Math.min(1000, notBefore - Date.now())));
						// keeps this member in the group while it waits
						await heartbeat();
					}
					if (!running) throw new Error("stopping");
					const job = JSON.parse(message.value?.toString() ?? "null") as JobEnvelope | null;
					if (job) await produce(options.topic, [{ job, delayMs: 0 }]);
				},
			});

			const consumer = options.kafka.consumer({ groupId: options.groupId });
			await consumer.connect();
			await consumer.subscribe({ topics: [options.topic] });
			await consumer.run({
				partitionsConsumedConcurrently: concurrency,
				eachMessage: async ({ message }) => {
					const job = JSON.parse(message.value?.toString() ?? "null") as JobEnvelope | null;
					if (!job) return;
					const outcome = await handle(job);
					if (outcome.status === "retry")
						await produce(delayed, [
							{ job: { ...job, attempt: job.attempt + 1 }, delayMs: outcome.delayMs },
						]);
					if (outcome.status === "dead")
						await produce(dead, [{ job, delayMs: 0 }], { "tatara-error": String(outcome.error) });
				},
			});
			for (const c of [consumer, waiter])
				c.on(c.events.CRASH, (event) =>
					logger.error({ err: event.payload.error }, "kafka consumer crashed"),
				);
			return async () => {
				// a waiting delayed message stays uncommitted and is picked up again after restart
				running = false;
				await Promise.all([consumer.disconnect(), waiter.disconnect()]);
			};
		},
	};
}
