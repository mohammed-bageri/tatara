import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAI } from "./client.ts";
import { AIError, type AIErrorCode } from "./errors.ts";
import type { AIProvider, AIProviderResult, AIRequest } from "./types.ts";

function fake(name: string, configured = true) {
	const generate = vi.fn<(r: AIRequest) => Promise<AIProviderResult>>(async (r) => ({
		text: `from-${name}`,
		model: r.model ?? `${name}-model`,
		usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
		raw: { name },
	}));
	const embed = vi.fn(async (texts: string[], _o: { dimensions?: number }) =>
		texts.map((t) => [t.length, 1]),
	);
	const provider: AIProvider = {
		configured,
		label: name,
		embeddingModel: `${name}-embed`,
		generate,
		embed,
	};
	return { provider, generate, embed };
}

const err = (code: AIErrorCode) => new AIError(code, code);
const logger = { warn: vi.fn() };

let a: ReturnType<typeof fake>;
let b: ReturnType<typeof fake>;
const make = (overrides: Partial<Parameters<typeof createAI>[0]> = {}) =>
	createAI({
		providers: { a: a.provider, b: b.provider },
		default: "a",
		fallback: "b",
		logger,
		retryDelaysMs: [0, 0],
		...overrides,
	});

beforeEach(() => {
	a = fake("a");
	b = fake("b");
	logger.warn.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("fallback", () => {
	it("answers from the default without touching the fallback", async () => {
		const res = await make().generateText("hi");
		expect(res).toMatchObject({ text: "from-a", provider: "a", model: "a-model" });
		expect(b.generate).not.toHaveBeenCalled();
	});

	it.each(["QUOTA_EXCEEDED", "BILLING_ERROR", "MODEL_UNAVAILABLE"] as const)(
		"falls back on %s and reports who answered",
		async (code) => {
			a.generate.mockRejectedValueOnce(err(code));
			const res = await make().generateText("hi");
			expect(res.provider).toBe("b");
			expect(res.text).toBe("from-b");
			expect(logger.warn).toHaveBeenCalledWith(
				{ failed: "a", next: "b", code },
				expect.any(String),
			);
		},
	);

	it.each(["SAFETY_FILTER", "INVALID_API_KEY", "AI_ERROR"] as const)(
		"does not fall back on %s",
		async (code) => {
			const e = err(code);
			a.generate.mockRejectedValueOnce(e);
			await expect(make().generateText("hi")).rejects.toBe(e);
			expect(b.generate).not.toHaveBeenCalled();
		},
	);

	it("classifies a raw error as AI_ERROR, tagged with the provider, and does not fall back", async () => {
		a.generate.mockRejectedValueOnce(new Error("boom"));
		const e = await make()
			.generateText("hi")
			.catch((x: unknown) => x);
		expect(e).toBeInstanceOf(AIError);
		expect(e).toMatchObject({ code: "AI_ERROR", kind: "other", provider: "a" });
		expect(b.generate).not.toHaveBeenCalled();
	});

	it("uses the provider's classifyError for raw errors", async () => {
		a.provider = { ...a.provider, classifyError: () => err("QUOTA_EXCEEDED") };
		a.generate.mockRejectedValueOnce(new Error("slow down"));
		expect((await make().generateText("hi")).provider).toBe("b");
	});

	it("throws the exhaustion error when there is no fallback", async () => {
		const e = err("QUOTA_EXCEEDED");
		a.generate.mockRejectedValueOnce(e);
		await expect(make({ fallback: undefined }).generateText("hi")).rejects.toBe(e);
	});

	it("skips a fallback that has no API key", async () => {
		b = fake("b", false);
		const e = err("QUOTA_EXCEEDED");
		a.generate.mockRejectedValueOnce(e);
		await expect(make().generateText("hi")).rejects.toBe(e);
		expect(b.generate).not.toHaveBeenCalled();
	});

	it("does not retry the same provider as its own fallback", async () => {
		a.generate.mockRejectedValueOnce(err("QUOTA_EXCEEDED"));
		await expect(make({ fallback: "a" }).generateText("hi")).rejects.toThrow(AIError);
		expect(a.generate).toHaveBeenCalledTimes(1);
	});

	it("starts from a per-call provider, then falls back", async () => {
		b.generate.mockRejectedValueOnce(err("QUOTA_EXCEEDED"));
		const res = await make({ fallback: "a" }).generateText("hi", { provider: "b" });
		expect(res.provider).toBe("a");
	});

	it("refuses a primary with no API key", async () => {
		a = fake("a", false);
		await expect(make().generateText("hi")).rejects.toMatchObject({
			code: "INVALID_API_KEY",
			kind: "auth",
			provider: "a",
		});
		expect(b.generate).not.toHaveBeenCalled();
	});

	it("rejects a default or fallback missing from providers", () => {
		expect(() => make({ default: "c" as "a" })).toThrow(/"c" is not in providers/);
		expect(() => make({ fallback: "c" as "a" })).toThrow(/"c" is not in providers/);
	});

	it("rejects options for a provider it cannot build", () => {
		expect(() =>
			createAI({ providers: { custom: { apiKey: "k" } }, default: "custom", logger }),
		).toThrow(/must be an AIProvider/);
	});
});

describe("cooldown", () => {
	it("tries a provider that hit an exhaustion error last until the window ends", async () => {
		vi.useFakeTimers();
		const ai = make({ cooldownMs: 60_000 });
		a.generate.mockRejectedValueOnce(err("QUOTA_EXCEEDED"));
		expect((await ai.generateText("1")).provider).toBe("b");
		vi.advanceTimersByTime(30_000);
		expect((await ai.generateText("2")).provider).toBe("b");
		expect(a.generate).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(30_001);
		expect((await ai.generateText("3")).provider).toBe("a");
		expect(a.generate).toHaveBeenCalledTimes(2);
	});

	it("keeps a cooling provider as the last resort", async () => {
		const ai = make();
		a.generate.mockRejectedValueOnce(err("QUOTA_EXCEEDED"));
		await ai.generateText("1");
		b.generate.mockRejectedValueOnce(err("QUOTA_EXCEEDED"));
		expect((await ai.generateText("2")).provider).toBe("a");
	});

	it("re-probes every call when cooldownMs is 0", async () => {
		const ai = make({ cooldownMs: 0 });
		a.generate.mockRejectedValue(err("QUOTA_EXCEEDED"));
		await ai.generateText("1");
		await ai.generateText("2");
		expect(a.generate).toHaveBeenCalledTimes(2);
	});

	it("resetCooldowns clears the state", async () => {
		const ai = make();
		a.generate.mockRejectedValueOnce(err("QUOTA_EXCEEDED"));
		await ai.generateText("1");
		ai.resetCooldowns();
		expect((await ai.generateText("2")).provider).toBe("a");
	});

	it("is per instance", async () => {
		a.generate.mockRejectedValueOnce(err("QUOTA_EXCEEDED"));
		await make().generateText("1");
		expect((await make().generateText("2")).provider).toBe("a");
	});
});

describe("retries", () => {
	it("retries a network error on the same provider", async () => {
		a.generate.mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"));
		expect((await make().generateText("hi")).provider).toBe("a");
		expect(a.generate).toHaveBeenCalledTimes(2);
	});

	it("gives up after the delays, classifies, and falls back on a 5xx", async () => {
		a.generate.mockRejectedValue(Object.assign(new Error("server"), { status: 503 }));
		expect((await make().generateText("hi")).provider).toBe("b");
		expect(a.generate).toHaveBeenCalledTimes(3);
	});

	it("does not retry a classified error", async () => {
		a.generate.mockRejectedValueOnce(err("SAFETY_FILTER"));
		await expect(make().generateText("hi")).rejects.toThrow();
		expect(a.generate).toHaveBeenCalledTimes(1);
	});
});

describe("request", () => {
	it("passes options and the file through untouched", async () => {
		const data = Buffer.from("%PDF-1.7 مرحبا");
		await make().generateText("read it", {
			system: "be brief",
			jsonMode: true,
			file: { data, mimeType: "application/pdf" },
			model: "big",
			temperature: 0.2,
			maxTokens: 50,
		});
		const request = a.generate.mock.calls[0]?.[0];
		expect(request).toEqual({
			prompt: "read it",
			system: "be brief",
			jsonMode: true,
			file: { data, mimeType: "application/pdf" },
			model: "big",
			temperature: 0.2,
			maxTokens: 50,
		});
		expect(request?.file?.data).toBe(data);
	});

	it("gives a model override to the first provider only", async () => {
		a.generate.mockRejectedValueOnce(err("QUOTA_EXCEEDED"));
		const res = await make().generateText("hi", { model: "a-big" });
		expect(a.generate.mock.calls[0]?.[0].model).toBe("a-big");
		expect(b.generate.mock.calls[0]?.[0].model).toBeUndefined();
		expect(res.model).toBe("b-model");
	});
});

describe("cost", () => {
	it("is null for a model with no price", async () => {
		expect((await make().generateText("hi")).costUsd).toBeNull();
	});

	it("uses the default table", async () => {
		const res = await make().generateText("hi", { model: "gpt-4o-mini" });
		expect(res.costUsd).toBe(0.75);
		expect(res.usage).toEqual({
			promptTokens: 1_000_000,
			completionTokens: 1_000_000,
			totalTokens: 2_000_000,
		});
	});

	it("takes app rows that add to and override the defaults", async () => {
		const ai = make({
			pricing: {
				"a-model": { inputPerMillion: 1, outputPerMillion: 2 },
				"gpt-4o-mini": { inputPerMillion: 0, outputPerMillion: 0 },
			},
		});
		expect((await ai.generateText("hi")).costUsd).toBe(3);
		expect((await ai.generateText("hi", { model: "gpt-4o-mini" })).costUsd).toBe(0);
		expect((await ai.generateText("hi", { model: "gpt-4o" })).costUsd).toBe(12.5);
	});

	it("is null without usage", async () => {
		a.generate.mockResolvedValueOnce({ text: "x", model: "gpt-4o", raw: {} });
		const res = await make().generateText("hi");
		expect(res.costUsd).toBeNull();
		expect(res.usage).toBeUndefined();
	});
});

describe("generateJson", () => {
	const answer = (text: string) => a.generate.mockResolvedValueOnce({ text, model: "m", raw: {} });

	it("turns JSON mode on and parses fenced output", async () => {
		answer('```json\n{"n":1}\n```');
		const res = await make().generateJson<{ n: number }>("give json", undefined, { system: "s" });
		expect(res.data).toEqual({ n: 1 });
		expect(res.provider).toBe("a");
		expect(a.generate.mock.calls[0]?.[0]).toMatchObject({ jsonMode: true, system: "s" });
	});

	it("validates with the schema", async () => {
		answer('{"n":"1"}');
		const schema = { parse: (v: unknown) => ({ n: Number((v as { n: string }).n) }) };
		expect((await make().generateJson("x", schema)).data).toEqual({ n: 1 });
	});

	it("throws INVALID_RESPONSE for prose or a failed schema", async () => {
		answer("sorry, no");
		await expect(make().generateJson("x")).rejects.toMatchObject({
			code: "INVALID_RESPONSE",
			provider: "a",
		});
		answer('{"n":1}');
		const schema = {
			parse: () => {
				throw new Error("bad");
			},
		};
		await expect(make().generateJson("x", schema)).rejects.toMatchObject({
			code: "INVALID_RESPONSE",
			cause: new Error("bad"),
		});
	});
});

describe("embed", () => {
	it("embeds with the default provider and reports the model", async () => {
		const res = await make().embed(["ab", "c"], { dimensions: 768 });
		expect(res).toEqual({
			embeddings: [
				[2, 1],
				[1, 1],
			],
			provider: "a",
			model: "a-embed",
		});
		expect(a.embed).toHaveBeenCalledWith(["ab", "c"], { dimensions: 768 });
	});

	it("never falls back", async () => {
		a.embed.mockRejectedValueOnce(err("QUOTA_EXCEEDED"));
		await expect(make().embed(["x"])).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
		expect(b.embed).not.toHaveBeenCalled();
	});

	it("skips the call for no texts", async () => {
		expect((await make().embed([])).embeddings).toEqual([]);
		expect(a.embed).not.toHaveBeenCalled();
	});

	it("refuses a provider without embeddings", async () => {
		const { embed: _, ...noEmbed } = a.provider;
		await expect(
			make({ providers: { a: noEmbed, b: b.provider } }).embed(["x"]),
		).rejects.toMatchObject({ code: "AI_ERROR" });
	});
});
