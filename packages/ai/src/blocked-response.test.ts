/**
 * `isBlockedResponse` tells a response the model refused (formerly empty text) from a request
 * the API refused (always an error). Runs `@tatara/ai`'s real providers over fake SDK clients.
 */

import { describe, expect, it } from "vitest";
import {
	createAI,
	type GeminiClient,
	geminiProvider,
	isBlockedResponse,
	type OpenAIClient,
	openaiProvider,
} from "./index.ts";

const logger = { warn: () => {} };

function gemini(generateContent: GeminiClient["models"]["generateContent"]) {
	const client = { models: { generateContent, embedContent: async () => ({}) } };
	return createAI({
		providers: { gemini: geminiProvider({ client }) },
		default: "gemini",
		retryDelaysMs: [],
		logger,
	});
}

function openai(create: OpenAIClient["chat"]["completions"]["create"]) {
	const client = {
		chat: { completions: { create } },
		responses: { create: async () => ({}) },
		embeddings: { create: async () => ({ data: [] }) },
	};
	return createAI({
		providers: { openai: openaiProvider({ client }) },
		default: "openai",
		retryDelaysMs: [],
		logger,
	});
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

describe("isBlockedResponse", () => {
	it("is true for a Gemini response blocked by a prompt block reason", async () => {
		const ai = gemini(async () => ({ promptFeedback: { blockReason: "SAFETY" } }));
		const err = await failure(ai.generateText("hi"));
		expect(err).toMatchObject({ code: "SAFETY_FILTER" });
		expect(isBlockedResponse(err)).toBe(true);
	});

	it("is true for a Gemini candidate that finished on SAFETY", async () => {
		const ai = gemini(async () => ({ candidates: [{ finishReason: "SAFETY" }] }));
		expect(isBlockedResponse(await failure(ai.generateText("hi")))).toBe(true);
	});

	it("is false when the Gemini request itself is refused", async () => {
		const ai = gemini(async () => {
			throw new Error("Request blocked by safety settings");
		});
		const err = await failure(ai.generateText("hi"));
		expect(err).toMatchObject({ code: "SAFETY_FILTER" });
		expect(isBlockedResponse(err)).toBe(false);
	});

	it("is true for an OpenAI completion that finished on content_filter", async () => {
		const ai = openai(async () => ({
			choices: [{ message: { content: null }, finish_reason: "content_filter" }],
		}));
		expect(isBlockedResponse(await failure(ai.generateText("hi")))).toBe(true);
	});

	it("is false when OpenAI refuses the request with a 400 content_filter", async () => {
		const ai = openai(async () => {
			throw Object.assign(new Error("content_filter"), { status: 400, code: "content_filter" });
		});
		const err = await failure(ai.generateText("hi"));
		expect(err).toMatchObject({ code: "SAFETY_FILTER" });
		expect(isBlockedResponse(err)).toBe(false);
	});

	it("is false for other AI errors and non-errors", async () => {
		const ai = gemini(async () => {
			throw new Error("quota exceeded");
		});
		expect(isBlockedResponse(await failure(ai.generateText("hi")))).toBe(false);
		expect(isBlockedResponse(new Error("SAFETY_FILTER"))).toBe(false);
	});
});
