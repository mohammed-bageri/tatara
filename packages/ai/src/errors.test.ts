import { describe, expect, it } from "vitest";
import {
	AIError,
	classifyError,
	isAIError,
	isExhaustionError,
	isTransientError,
} from "./errors.ts";
import { classifyGeminiError } from "./gemini.ts";
import { parseAiJson } from "./json.ts";
import { classifyOpenAIError } from "./openai.ts";
import { DEFAULT_PRICING, estimateCostUsd } from "./pricing.ts";
import { cosineSimilarity } from "./vector.ts";

const status = (code: number, extra: Record<string, unknown> = {}, msg = "error") =>
	Object.assign(new Error(msg), { status: code, ...extra });

describe("AIError", () => {
	it("derives kind and status from the code", () => {
		const e = new AIError("x", "QUOTA_EXCEEDED");
		expect([e.kind, e.statusCode, e.name]).toEqual(["exhaustion", 429, "AIError"]);
		expect(new AIError("x", "SAFETY_FILTER").kind).toBe("safety");
		expect(new AIError("x", "INVALID_API_KEY").kind).toBe("auth");
		expect(new AIError("x", "AI_ERROR", { statusCode: 500 }).statusCode).toBe(500);
		expect(isExhaustionError(new AIError("x", "BILLING_ERROR"))).toBe(true);
		expect(isExhaustionError(new AIError("x", "SAFETY_FILTER"))).toBe(false);
		expect(isAIError(e, "QUOTA_EXCEEDED")).toBe(true);
		expect(isAIError(e, "AI_ERROR")).toBe(false);
	});
});

describe("classifyGeminiError", () => {
	it.each([
		["API key not valid. Please pass a valid API key.", "INVALID_API_KEY"],
		["got status: 429. RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"],
		["billing account disabled", "BILLING_ERROR"],
		["Response was blocked due to SAFETY", "SAFETY_FILTER"],
		["models/gemini-9 is not found", "MODEL_UNAVAILABLE"],
		["something odd", "AI_ERROR"],
	] as const)("%s → %s", (msg, code) => {
		const e = classifyGeminiError(new Error(msg));
		expect(e.code).toBe(code);
		expect(e.cause).toBeInstanceOf(Error);
	});
});

describe("classifyOpenAIError", () => {
	it.each([
		[status(401), "INVALID_API_KEY"],
		[status(429, { code: "insufficient_quota" }), "BILLING_ERROR"],
		[status(429), "QUOTA_EXCEEDED"],
		[status(400, { code: "content_filter" }), "SAFETY_FILTER"],
		[status(404, { code: "model_not_found" }), "MODEL_UNAVAILABLE"],
		[status(502), "MODEL_UNAVAILABLE"],
		[status(400), "AI_ERROR"],
	] as const)("%#: → %s", (error, code) => {
		expect(classifyOpenAIError(error).code).toBe(code);
	});

	it("passes an AIError through", () => {
		const e = new AIError("x", "SAFETY_FILTER");
		expect(classifyOpenAIError(e)).toBe(e);
	});
});

it("classifyError picks status rules when there is a status", () => {
	expect(classifyError(status(429)).code).toBe("QUOTA_EXCEEDED");
	expect(classifyError(new Error("rate limit")).code).toBe("QUOTA_EXCEEDED");
	expect(classifyError("plain string").code).toBe("AI_ERROR");
});

it("isTransientError: network and 5xx, not 4xx or classified errors", () => {
	expect(isTransientError(new Error("fetch failed"))).toBe(true);
	expect(isTransientError(new Error("Request timeout"))).toBe(true);
	expect(isTransientError(status(500))).toBe(true);
	expect(isTransientError(status(408))).toBe(true);
	expect(isTransientError(status(429))).toBe(false);
	expect(isTransientError(new AIError("503", "MODEL_UNAVAILABLE"))).toBe(false);
	expect(isTransientError("fetch")).toBe(false);
});

describe("parseAiJson", () => {
	it.each([
		['{"a":1}', { a: 1 }],
		['```json\n{"a":1}\n```', { a: 1 }],
		['```\n{"a":1}\n```', { a: 1 }],
		['Here you go: {"a":1} — done', { a: 1 }],
		["[1,2,3]", [1, 2, 3]],
	])("%s", (text, expected) => {
		expect(parseAiJson(text)).toEqual(expected);
	});

	it("throws SyntaxError without JSON", () => {
		expect(() => parseAiJson("no json here")).toThrow(SyntaxError);
	});
});

it("estimateCostUsd prices known models and returns null otherwise", () => {
	expect(estimateCostUsd(DEFAULT_PRICING, "gpt-4o", 1000, 500)).toBe(0.0075);
	expect(estimateCostUsd(DEFAULT_PRICING, "unknown", 1000, 500)).toBeNull();
	expect(estimateCostUsd(DEFAULT_PRICING, undefined, 1000, 500)).toBeNull();
});

it("cosineSimilarity", () => {
	expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
	expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
	expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
});
