import { describe, expect, it, vi } from "vitest";
import { isRetryableTxConflict, retryOnceOnTxConflict } from "./index.ts";

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe("retryOnceOnTxConflict", () => {
	it("recognises deadlocks and serialization failures, directly or on the cause", () => {
		expect(isRetryableTxConflict(pgError("40P01"))).toBe(true);
		expect(isRetryableTxConflict(pgError("40001"))).toBe(true);
		expect(isRetryableTxConflict(new Error("wrapped", { cause: pgError("40P01") }))).toBe(true);
		expect(isRetryableTxConflict(pgError("23505"))).toBe(false);
		expect(isRetryableTxConflict(new Error("plain"))).toBe(false);
		expect(isRetryableTxConflict(null)).toBe(false);
	});

	it("re-runs once after a conflict", async () => {
		const fn = vi.fn().mockRejectedValueOnce(pgError("40P01")).mockResolvedValueOnce("ok");
		await expect(retryOnceOnTxConflict(fn)).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("throws a second conflict", async () => {
		const fn = vi.fn().mockRejectedValue(pgError("40001"));
		await expect(retryOnceOnTxConflict(fn)).rejects.toThrow("pg 40001");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("does not retry any other error", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("boom"));
		await expect(retryOnceOnTxConflict(fn)).rejects.toThrow("boom");
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
