import { defineSubscriber } from "@tatara/events";
import greetingSent from "#modules/example/events/greeting";

/** Example subscriber. Delivery is at-least-once: a real one must be idempotent per event.id. */
export default defineSubscriber({
	name: "example.log-greeting",
	event: greetingSent,
	async handle(event, { logger }) {
		logger.info({ name: event.payload.name }, "greeting noticed");
	},
});
