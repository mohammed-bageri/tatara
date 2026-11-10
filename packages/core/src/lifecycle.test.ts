import { afterEach, describe, expect, it, vi } from "vitest";
import { type CoreLogger, createLifecycle } from "./index.ts";

const silent = { info: () => {}, error: vi.fn(), child: () => silent } as unknown as CoreLogger;

afterEach(() => {
	vi.useRealTimers();
});

describe("lifecycle", () => {
	it("runs hooks in reverse order", async () => {
		const order: string[] = [];
		const life = createLifecycle({ exit: () => {} });
		life.onShutdown("first", () => {
			order.push("first");
		});
		life.onShutdown("second", () => {
			order.push("second");
		});
		await life.shutdown(0, silent);
		expect(order).toEqual(["second", "first"]);
	});

	it("logs a failing hook and runs the rest", async () => {
		const ran: string[] = [];
		const logger = { ...silent, error: vi.fn() } as unknown as CoreLogger & {
			error: ReturnType<typeof vi.fn>;
		};
		const life = createLifecycle({ exit: () => {} });
		life.onShutdown("ok", () => {
			ran.push("ok");
		});
		life.onShutdown("bad", () => {
			throw new Error("boom");
		});
		await life.shutdown(0, logger);
		expect(ran).toEqual(["ok"]);
		expect(logger.error).toHaveBeenCalledTimes(1);
	});

	it("waits for waitUntil work before the hooks", async () => {
		const order: string[] = [];
		const life = createLifecycle({ exit: () => {} });
		life.waitUntil(
			new Promise<void>((r) => setTimeout(() => r(order.push("work") as unknown as void), 20)),
		);
		life.onShutdown("hook", () => {
			order.push("hook");
		});
		await life.shutdown(0, silent);
		expect(order).toEqual(["work", "hook"]);
	});

	it("stops waiting after the timeout", async () => {
		vi.useFakeTimers();
		const logger = { ...silent, info: vi.fn() } as unknown as CoreLogger & {
			info: ReturnType<typeof vi.fn>;
		};
		const ran: string[] = [];
		const life = createLifecycle({ exit: () => {}, shutdownTimeoutMs: 1000 });
		life.waitUntil(new Promise(() => {}));
		life.onShutdown("hook", () => {
			ran.push("hook");
		});
		const done = life.shutdown(0, logger);
		await vi.advanceTimersByTimeAsync(1000);
		await done;
		expect(ran).toEqual(["hook"]);
		expect(JSON.stringify(logger.info.mock.calls)).toContain("gave up");
	});

	it("exits 1 when a hook failed, even for a signal's clean shutdown", async () => {
		const exit = vi.fn();
		const life = createLifecycle({ exit });
		life.onShutdown("db", () => {
			throw new Error("pool did not close");
		});
		life.onShutdown("http", () => {});
		await life.shutdown(0, silent);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("exits with the given code", async () => {
		const exit = vi.fn();
		await createLifecycle({ exit }).shutdown(3, silent);
		expect(exit).toHaveBeenCalledWith(3);
	});
});
