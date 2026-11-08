import { type CommandDefinition, defineCommand } from "@tatara/core";
import { z } from "zod";

/** events:relay, events:retry and events:requeue-dead; wired into the app by `tatara sync`. */
export function eventsCommands({
	events,
}: {
	events: {
		relay(): Promise<number>;
		retry(): Promise<number>;
		requeueDead(filter?: { subscriber?: string; eventId?: string }): Promise<number>;
	};
}): CommandDefinition[] {
	return [
		defineCommand({
			name: "events:relay",
			description: "Publish the events still waiting in the outbox now",
			async run(_args, { logger }) {
				logger.info({ count: await events.relay() }, "events relayed");
			},
		}),
		defineCommand({
			name: "events:retry",
			description: "Run the event deliveries that are due for a retry now",
			async run(_args, { logger }) {
				logger.info({ count: await events.retry() }, "event deliveries retried");
			},
		}),
		defineCommand({
			name: "events:requeue-dead",
			description:
				"Make dead event deliveries due again, once their handler is fixed (attempts are kept)",
			args: z.object({ subscriber: z.string().optional(), event: z.string().optional() }),
			async run({ subscriber, event }, { logger }) {
				const count = await events.requeueDead({ subscriber, eventId: event });
				logger.info({ count, subscriber, event }, "dead event deliveries requeued");
			},
		}),
	] as CommandDefinition[];
}
