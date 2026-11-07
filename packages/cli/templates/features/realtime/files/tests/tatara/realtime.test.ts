import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { io } from "socket.io-client";
import { afterAll, describe, expect, it } from "vitest";
import { app } from "#apps/api/app";
import { env } from "#core/config/env";
import { publishToUser, realtime } from "#core/realtime/index";
import { authenticate } from "#tests/helpers/auth";

let server: Server | undefined;
afterAll(() => new Promise((r) => (server ? server.close(r) : r(undefined))));

describe("realtime", () => {
	it("connects with a ticket from the API and receives what the app publishes to the user", async () => {
		server = await new Promise<Server>((resolve) => {
			const started = serve({ fetch: app.fetch, port: 0 }, () => resolve(started as Server));
		});
		await realtime.attach(server);
		const url = `http://localhost:${(server.address() as AddressInfo).port}`;

		const user = await authenticate();
		const res = await fetch(`${url}/api/realtime/ticket`, { method: "POST", headers: user.headers });
		expect(res.status).toBe(200);
		const { ticket } = ((await res.json()) as { data: { ticket: string } }).data;

		const socket = io(url, { path: env.REALTIME_PATH, transports: ["websocket"], auth: { ticket }, reconnection: false });
		await new Promise<void>((resolve, reject) => {
			socket.on("connect", resolve);
			socket.on("connect_error", reject);
		});
		// every event arrives as one "rt" envelope: { id, v, ch, ev, ts, data }
		const got = new Promise((r) => socket.once("rt", r));
		await publishToUser(user.orgId ?? "default", user.userId, "hello", { n: 1 });
		expect(await got).toMatchObject({ v: 1, ch: `user:${user.userId}`, ev: "hello", data: { n: 1 } });
		socket.close();
	});
});
