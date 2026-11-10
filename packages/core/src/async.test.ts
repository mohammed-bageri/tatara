import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./async.ts";

describe("mapWithConcurrency", () => {
	it("keeps input order and never runs more than the limit at once", async () => {
		let inFlight = 0;
		let peak = 0;
		const result = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, n * 3));
			inFlight--;
			return n * 10;
		});
		expect(result).toEqual([50, 10, 40, 20, 30]);
		expect(peak).toBe(2);
	});

	it("handles an empty list and refuses a non-positive limit", async () => {
		expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
		await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toThrow("positive integer");
	});
});
