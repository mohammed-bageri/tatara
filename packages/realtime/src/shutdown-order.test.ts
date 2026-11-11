import { createServer } from "node:http";
import { onShutdown, shutdown } from "@tatara/core";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createRealtime, type SocketIdentity, type TicketStore } from "./index.ts";

function memoryTickets(): TicketStore {
	const map = new Map<string, SocketIdentity>();
	return {
		async add(key, value) {
			if (map.has(key)) return false;
			map.set(key, value);
			return true;
		},
		async take(key) {
			const value = map.get(key) ?? null;
			map.delete(key);
			return value;
		},
	};
}

// Its own file: shutdown() runs once per process.
describe("shutdown order", () => {
	it("closes realtime, then the HTTP server, then the database", async () => {
		const realtime = createRealtime({
			driver: "socketio",
			adapter: { kind: "memory" },
			tickets: memoryTickets(),
			allowOrigin: () => true,
			logger: pino({ level: "silent" }),
		});
		const server = createServer();
		const order: string[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

		// an app's database hook is registered at import, before any server exists
		onShutdown("database", () => void order.push("database"));
		// as @tatara/http's startServer does: onServer attaches, then the server's hook is registered
		const attached = realtime.attach(server);
		onShutdown("api-http", async () => {
			const { status } = await realtime.health();
			order.push(`http (realtime ${status})`);
		});
		await attached;
		await shutdown(0);

		// the sockets are already closed when the server's hook runs, and the database goes last
		expect(order).toEqual(["http (realtime unhealthy)", "database"]);
		expect(exit).toHaveBeenCalledWith(0);
		exit.mockRestore();
	});
});
