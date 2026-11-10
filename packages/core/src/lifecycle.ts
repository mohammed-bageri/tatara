import type { CoreLogger } from "./logger.ts";

type Hook = () => Promise<void> | void;

export interface LifecycleOptions {
	/** how long shutdown waits for `waitUntil` work before giving up (default 10 s) */
	shutdownTimeoutMs?: number;
	/** replaces `process.exit` (tests) */
	exit?: (code: number) => void;
}

export function createLifecycle(options: LifecycleOptions = {}) {
	const timeoutMs = options.shutdownTimeoutMs ?? 10_000;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const hooks: { name: string; run: Hook }[] = [];
	const pending = new Set<Promise<unknown>>();
	let shuttingDown = false;

	/** Registers cleanup that runs on SIGTERM/SIGINT or `shutdown()`, last registered first. */
	function onShutdown(name: string, run: Hook): void {
		hooks.push({ name, run });
	}

	/** Work that shutdown waits for (bounded by the timeout) before running hooks. */
	function waitUntil(promise: Promise<unknown>): void {
		const tracked = promise.finally(() => pending.delete(tracked));
		pending.add(tracked);
		tracked.catch(() => {});
	}

	async function drain(logger?: CoreLogger): Promise<void> {
		if (pending.size === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		const result = await Promise.race([
			Promise.allSettled([...pending]).then(() => "done" as const),
			timedOut,
		]);
		clearTimeout(timer);
		if (result === "timeout") {
			logger?.info({ pending: pending.size, timeoutMs }, "gave up waiting for in-flight work");
		}
	}

	let hookFailed = false;

	/** Runs every hook (last registered first); exits 1 if any hook failed, else `code`. */
	async function shutdown(code = 0, logger?: CoreLogger): Promise<void> {
		if (!shuttingDown) {
			shuttingDown = true;
			await drain(logger);
			for (const hook of [...hooks].reverse()) {
				try {
					await hook.run();
				} catch (error) {
					hookFailed = true;
					logger?.error({ err: error, hook: hook.name }, "shutdown hook failed");
				}
			}
		}
		// a failed cleanup must not look like a clean exit to the process supervisor
		exit(hookFailed ? 1 : code);
	}

	function handleSignals(logger: CoreLogger): void {
		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			process.once(signal, () => {
				logger.info({ signal }, "shutting down");
				void shutdown(0, logger);
			});
		}
	}

	return { onShutdown, waitUntil, shutdown, handleSignals };
}
