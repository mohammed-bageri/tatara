import { describe, expect, it } from "vitest";
import { parseAiJson } from "./index.ts";

describe("parseAiJson (core)", () => {
	it("parses plain JSON", () => {
		expect(parseAiJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
	});

	it("strips ```json fences", () => {
		expect(parseAiJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it("strips bare ``` fences", () => {
		expect(parseAiJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it("recovers JSON embedded in prose", () => {
		expect(parseAiJson('Here you go: {"a":1} — done')).toEqual({ a: 1 });
	});

	it("parses arrays", () => {
		expect(parseAiJson<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
	});

	it("throws when no JSON is present", () => {
		expect(() => parseAiJson("no json here")).toThrow(SyntaxError);
	});
});
