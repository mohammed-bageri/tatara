import { createJobs, inlineDriver, type JobDriver, lazyRedis, type TopicsOf } from "@tatara/jobs";
import { bullmqDriver } from "@tatara/jobs/bullmq";
import { kafkaDriver } from "@tatara/jobs/kafka";
import { postgresDriver } from "@tatara/jobs/postgres";
import { Kafka } from "kafkajs";
import { env } from "#core/config/env";
import { outboxPool } from "#core/jobs/outbox";
import { logger } from "#core/logging/logger";
import type { consumers } from "#generated/consumers";

export { inTransaction } from "#core/jobs/outbox";

/** The shared Redis connection for BullMQ, opened on first use. */
export const redis = lazyRedis(env.REDIS_URL);

// `{ executor: inTransaction(tx) }` with any driver: the job waits in tatara.job_outbox until commit
const outbox = { db: outboxPool, logger };

function kafka(): JobDriver {
	if (!env.KAFKA_BROKERS) throw new Error("JOBS_DRIVER=kafka needs KAFKA_BROKERS");
	const client = new Kafka({
		clientId: env.KAFKA_CLIENT_ID,
		brokers: env.KAFKA_BROKERS.split(","),
		ssl: env.KAFKA_SSL,
		...(env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD
			? {
					sasl: {
						mechanism: "scram-sha-512",
						username: env.KAFKA_SASL_USERNAME,
						password: env.KAFKA_SASL_PASSWORD,
					},
				}
			: {}),
	});
	return kafkaDriver({ kafka: client, topic: "__APP_NAME__.jobs", groupId: env.KAFKA_CLIENT_ID, outbox });
}

const drivers: Record<typeof env.JOBS_DRIVER, () => JobDriver> = {
	bullmq: () => bullmqDriver({ name: "__APP_NAME__-jobs", prefix: env.JOBS_PREFIX, redis, outbox }),
	// a "tatara.jobs" table, claimed with SKIP LOCKED; enqueue with { executor: inTransaction(tx) }
	postgres: () => postgresDriver({ db: outboxPool }),
	kafka,
	// jobs run where they're sent, with no worker: tests and quick local work
	inline: () =>
		inlineDriver({ consumers: async () => (await import("#generated/consumers")).consumers, logger, outbox }),
};

/** `jobs.enqueue(topic, data, { orgId })`, typed by the app's consumers; pick the driver with JOBS_DRIVER. */
export const jobs = createJobs<TopicsOf<typeof consumers>>({ driver: drivers[env.JOBS_DRIVER]() });
export const { enqueue } = jobs;
