import type { EventsConsumer } from "@tatara/events";
import { events } from "#core/events/index";

/** Runs an event's subscribers in the worker; the relay enqueues one job per event. */
const dispatch: EventsConsumer = events.consumer;
export default dispatch;
