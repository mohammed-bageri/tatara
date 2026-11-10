import { describe, expect, it } from "vitest";
import { rewriteErrors } from "./error-options.ts";

describe("error-options", () => {
	it("turns NotFoundError's resource into its message", () => {
		expect(rewriteErrors('throw new NotFoundError("Job");')).toBe(
			'throw new NotFoundError("Job not found");',
		);
		expect(rewriteErrors("throw new NotFoundError(`Job ${id}`);")).toBe(
			"throw new NotFoundError(`Job ${id} not found`);",
		);
		expect(rewriteErrors("throw new NotFoundError(label(x, y));")).toBe(
			"throw new NotFoundError(`${label(x, y)} not found`);",
		);
		expect(rewriteErrors("throw new NotFoundError();")).toBe("throw new NotFoundError();");
	});

	it("moves details and codes into the options", () => {
		expect(rewriteErrors('new ConflictError("Taken", { field: "a, b" })')).toBe(
			'new ConflictError("Taken", { details: { field: "a, b" } })',
		);
		expect(rewriteErrors('new ConflictError("Taken")')).toBe('new ConflictError("Taken")');
		expect(rewriteErrors('new ServiceUnavailableError("Down", "QUEUE_DOWN")')).toBe(
			'new ServiceUnavailableError("Down", { code: "QUEUE_DOWN" })',
		);
	});

	it("changes nothing the second time", () => {
		const once = rewriteErrors(
			'new NotFoundError("Job"); new ConflictError("T", d); new ServiceUnavailableError("D", "C");',
		);
		expect(rewriteErrors(once)).toBe(once);
	});

	it("rewrites every call in a file", () => {
		expect(rewriteErrors('a(new NotFoundError("A")); b(new NotFoundError("B"));')).toBe(
			'a(new NotFoundError("A not found")); b(new NotFoundError("B not found"));',
		);
	});
});
