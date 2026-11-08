import type { InlineDriver } from "@tatara/jobs";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "#core/db/client";
import { domainEventDeliveries, domainEvents } from "#core/events/db/events.schema";
import { events } from "#core/events/index";
import { jobs } from "#core/jobs/index";
import greetingSent from "#modules/example/events/greeting";
import { resetDatabase } from "#tests/helpers/db";

beforeEach(async () => {
	await resetDatabase();
});

describe("domain events", () => {
	it("writes an event with the caller's transaction, and none on rollback", async () => {
		await expect(
			db.transaction(async (tx) => {
				await events.emit(tx, greetingSent, { payload: { name: "Ada" } });
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(await db.select().from(domainEvents)).toEqual([]);

		const id = await db.transaction((tx) =>
			events.emit(tx, "example.greeting.sent", { payload: { name: "Ada" }, actor: { type: "user", id: "u1" } }),
		);
		const [row] = await db.select().from(domainEvents).where(eq(domainEvents.id, id));
		expect(row).toMatchObject({ name: "example.greeting.sent", payload: { name: "Ada" }, publishedAt: null });
	});

	it("relays a committed event to the worker, which runs each subscriber once", async () => {
		const id = await db.transaction((tx) => events.emit(tx, greetingSent, { payload: { name: "Ada" } }));
		expect(await events.relay()).toBe(1);
		await (jobs.driver as InlineDriver).drain();
		await events.dispatch(id);
		const deliveries = await db.select().from(domainEventDeliveries).where(eq(domainEventDeliveries.eventId, id));
		expect(deliveries).toEqual([expect.objectContaining({ subscriber: "example.log-greeting", status: "done" })]);
	});
});
