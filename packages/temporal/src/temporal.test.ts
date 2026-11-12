import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { defineActivities, mergeActivities } from "./activities.ts";
import { connectionOptions, createTemporal } from "./client.ts";
import { isTemporalUnavailable, TemporalUnavailableError } from "./errors.ts";
import { defineWorkflowSchedule, syncSchedules } from "./schedules.ts";
import { sdkLogger, workflowsPath } from "./worker.ts";

const logger = pino({ level: "silent" });
const config = { address: "localhost:7233", namespace: "default", taskQueue: "app" };

describe("isTemporalUnavailable", () => {
	it("recognises transport and unavailable errors through the cause chain", () => {
		expect(isTemporalUnavailable(Object.assign(new Error("x"), { name: "TransportError" }))).toBe(
			true,
		);
		expect(isTemporalUnavailable({ code: 14 })).toBe(true);
		expect(isTemporalUnavailable(new Error("wrapped", { cause: { code: 4 } }))).toBe(true);
		expect(isTemporalUnavailable(new Error("workflow failed"))).toBe(false);
		expect(isTemporalUnavailable({ code: 5 })).toBe(false);
	});
});

describe("connectionOptions", () => {
	it("turns TLS on with an API key", () => {
		expect(connectionOptions(config)).toEqual({ address: "localhost:7233" });
		expect(connectionOptions({ ...config, apiKey: "k" })).toEqual({
			address: "localhost:7233",
			tls: true,
			apiKey: "k",
		});
	});
});

describe("createTemporal", () => {
	it("maps an unreachable server to TemporalUnavailableError and retries the connection", async () => {
		const unreachable = Object.assign(new Error("connect failed"), { name: "TransportError" });
		const connect = vi.fn().mockRejectedValue(unreachable);
		const temporal = createTemporal(config, { connect });
		await expect(temporal.start("greet", { workflowId: "w1", args: [] })).rejects.toBeInstanceOf(
			TemporalUnavailableError,
		);
		await expect(temporal.check()).rejects.toBeInstanceOf(TemporalUnavailableError);
		expect(connect).toHaveBeenCalledTimes(2);
	});

	it("treats any connect failure as unavailable, keeping the cause", async () => {
		const deadline = new Error("Failed to connect before the deadline");
		const temporal = createTemporal(config, { connect: vi.fn().mockRejectedValue(deadline) });
		const error = await temporal.start("greet", { workflowId: "w1", args: [] }).catch((e) => e);
		expect(error).toBeInstanceOf(TemporalUnavailableError);
		expect(error.cause).toBe(deadline);
	});

	it("passes errors from a connected call through", async () => {
		const connection = {
			workflowService: { getSystemInfo: vi.fn().mockRejectedValue(new Error("bad namespace")) },
			close: vi.fn(),
		};
		const temporal = createTemporal(config, { connect: vi.fn().mockResolvedValue(connection) });
		await expect(temporal.check()).rejects.toThrow("bad namespace");
	});
});

describe("mergeActivities", () => {
	it("gives an empty object for an app with no activities", () => {
		const none: object = mergeActivities();
		expect(none).toEqual({});
	});

	it("merges sets and rejects duplicate names", async () => {
		const a = defineActivities({ one: async () => 1 });
		const b = defineActivities({ two: async (x: string) => x });
		const merged = mergeActivities(a, b);
		expect(Object.keys(merged)).toEqual(["one", "two"]);
		await expect(merged.two("ok")).resolves.toBe("ok");
		expect(() => mergeActivities(a, defineActivities({ one: async () => 2 }))).toThrow(
			'Duplicate activity "one"',
		);
	});
});

function fakeSchedules(existing: { scheduleId: string; memo?: Record<string, unknown> }[]) {
	const calls = { created: [] as unknown[], updated: [] as string[], deleted: [] as string[] };
	const ids = new Set(existing.map((s) => s.scheduleId));
	return {
		calls,
		client: {
			async *list() {
				yield* existing;
			},
			async create(options: { scheduleId: string }) {
				if (ids.has(options.scheduleId)) {
					throw Object.assign(new Error("exists"), { name: "ScheduleAlreadyRunning" });
				}
				calls.created.push(options);
			},
			getHandle(id: string) {
				return {
					async update(fn: (previous: { policies: object }) => unknown) {
						fn({ policies: { catchupWindow: 60 } });
						calls.updated.push(id);
					},
					async delete() {
						calls.deleted.push(id);
					},
				};
			},
		},
	};
}

describe("syncSchedules", () => {
	const nightly = defineWorkflowSchedule({
		id: "billing.nightly",
		workflow: "nightlyInvoices",
		cron: "0 2 * * *",
		timezone: "Asia/Riyadh",
	});

	it("creates new schedules paused when asked, with the managed memo", async () => {
		const { client, calls } = fakeSchedules([]);
		const result = await syncSchedules(client as never, [nightly], {
			taskQueue: "app",
			paused: true,
			logger,
		});
		expect(result).toEqual({ created: ["billing.nightly"], updated: [], deleted: [] });
		expect(calls.created[0]).toMatchObject({
			scheduleId: "billing.nightly",
			spec: { cronExpressions: ["0 2 * * *"], timezone: "Asia/Riyadh" },
			action: { type: "startWorkflow", workflowType: "nightlyInvoices", taskQueue: "app" },
			state: { paused: true },
			memo: { tatara: "managed" },
		});
	});

	it("updates existing ones, takes over unmanaged ones, deletes only its own leftovers", async () => {
		const { client, calls } = fakeSchedules([
			{ scheduleId: "billing.nightly", memo: { tatara: "managed" } },
			{ scheduleId: "old.removed", memo: { tatara: "managed" } },
			{ scheduleId: "made.by.hand" },
		]);
		const byHand = defineWorkflowSchedule({ id: "made.by.hand", workflow: "w", cron: "* * * * *" });
		const result = await syncSchedules(client as never, [nightly, byHand], {
			taskQueue: "app",
			logger,
		});
		expect(result).toEqual({
			created: [],
			updated: ["billing.nightly", "made.by.hand"],
			deleted: ["old.removed"],
		});
		expect(calls.deleted).toEqual(["old.removed"]);
	});

	it("rejects duplicate ids", async () => {
		const { client } = fakeSchedules([]);
		await expect(
			syncSchedules(client as never, [nightly, nightly], { taskQueue: "app", logger }),
		).rejects.toThrow('Duplicate workflow schedule "billing.nightly"');
	});
});

describe("worker helpers", () => {
	it("picks the source workflows under src and the built file under dist", () => {
		const paths = { source: "../../generated/workflows.ts", built: "../../workflows.mjs" };
		expect(workflowsPath("file:///app/src/apps/temporal-worker/index.ts", paths)).toBe(
			"/app/src/generated/workflows.ts",
		);
		expect(workflowsPath("file:///app/dist/apps/temporal-worker/index.mjs", paths)).toBe(
			"/app/dist/workflows.mjs",
		);
	});

	it("maps SDK log levels onto the app logger", () => {
		const warn = vi.spyOn(logger, "warn");
		sdkLogger(logger).log("WARN", "slow poll", { taskQueue: "app" });
		expect(warn).toHaveBeenCalledWith({ taskQueue: "app" }, "slow poll");
	});
});
