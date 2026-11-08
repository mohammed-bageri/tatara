// Calls the real APIs, only when TATARA_TEST_GEMINI_API_KEY / TATARA_TEST_OPENAI_API_KEY are set.
import { describe, expect, it } from "vitest";
import { createAI } from "./client.ts";

const logger = { warn: () => {} };
const keys = {
	gemini: process.env.TATARA_TEST_GEMINI_API_KEY,
	openai: process.env.TATARA_TEST_OPENAI_API_KEY,
};

for (const name of ["gemini", "openai"] as const) {
	describe.skipIf(!keys[name])(`${name} (live)`, () => {
		const ai = createAI({ providers: { [name]: { apiKey: keys[name] } }, default: name, logger });

		it("answers JSON with usage and cost", { timeout: 60_000 }, async () => {
			const res = await ai.generateJson<{ answer: number }>(
				'What is 2 + 2? Reply as JSON: {"answer": <number>}',
			);
			expect(res.data.answer).toBe(4);
			expect(res.usage?.totalTokens).toBeGreaterThan(0);
			expect(res.costUsd).toBeGreaterThan(0);
		});

		it("embeds at the asked dimensions", { timeout: 60_000 }, async () => {
			const res = await ai.embed(["hello", "مرحبا"], { dimensions: 768 });
			expect(res.embeddings.map((v) => v.length)).toEqual([768, 768]);
		});
	});
}
