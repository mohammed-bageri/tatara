import { describe, expect, it, vi } from "vitest";
import { AIError, type AIProvider, createAI } from "@tatara/ai";
import { ai } from "#core/ai/index";

const provider = (generate: AIProvider["generate"]): AIProvider => ({ configured: true, generate });

describe("ai", () => {
	it("refuses without an API key, before any network call", async () => {
		await expect(ai.generateText("hi")).rejects.toMatchObject({ code: "INVALID_API_KEY" });
	});

	it("falls back when the default provider is exhausted", async () => {
		const client = createAI({
			providers: {
				main: provider(async () => {
					throw new AIError("quota", "QUOTA_EXCEEDED");
				}),
				backup: provider(async () => ({ text: '{"ok":true}', model: "m", raw: {} })),
			},
			default: "main",
			fallback: "backup",
			logger: { warn: vi.fn() },
		});
		const res = await client.generateJson<{ ok: boolean }>("hi");
		expect(res).toMatchObject({ provider: "backup", data: { ok: true } });
	});
});
