import { describe, expect, it, vi } from "vitest";
import { createAI } from "./client.ts";
import { type GeminiClient, geminiProvider } from "./gemini.ts";
import { type OpenAIClient, openaiProvider } from "./openai.ts";

const pdf = Buffer.from("%PDF-1.7 عقد إيجار");
const logger = { warn: vi.fn() };

function geminiClient(
	response: Awaited<ReturnType<GeminiClient["models"]["generateContent"]>> = {},
) {
	return {
		models: {
			generateContent: vi.fn(async () => ({
				text: "ok",
				usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
				...response,
			})),
			embedContent: vi.fn(async () => ({ embeddings: [{ values: [0.1, 0.2] }] })),
		},
	} satisfies GeminiClient;
}

function openaiClient(finish = "stop") {
	return {
		chat: {
			completions: {
				create: vi.fn(async () => ({
					choices: [{ message: { content: "chat" }, finish_reason: finish }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				})),
			},
		},
		responses: {
			create: vi.fn(async () => ({
				output_text: "file",
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			})),
		},
		embeddings: { create: vi.fn(async () => ({ data: [{ embedding: [1, 2] }] })) },
	} satisfies OpenAIClient;
}

describe("geminiProvider", () => {
	it("is configured only with a key or a client", () => {
		expect(geminiProvider({}).configured).toBe(false);
		expect(geminiProvider({ apiKey: "" }).configured).toBe(false);
		expect(geminiProvider({ apiKey: "k" }).configured).toBe(true);
	});

	it("sends a text prompt with JSON mode, system, temperature and max tokens", async () => {
		const client = geminiClient();
		const res = await geminiProvider({ client }).generate({
			prompt: "hi",
			jsonMode: true,
			system: "sys",
			temperature: 0,
			maxTokens: 9,
		});
		expect(client.models.generateContent).toHaveBeenCalledWith({
			model: "gemini-2.5-flash",
			contents: "hi",
			config: {
				responseMimeType: "application/json",
				systemInstruction: "sys",
				temperature: 0,
				maxOutputTokens: 9,
			},
		});
		expect(res).toMatchObject({
			text: "ok",
			model: "gemini-2.5-flash",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		});
	});

	it("sends a file as inline base64 bytes before the prompt", async () => {
		const client = geminiClient();
		await geminiProvider({ client, model: "gemini-2.5-pro" }).generate({
			prompt: "extract",
			file: { data: pdf, mimeType: "application/pdf" },
		});
		expect(client.models.generateContent).toHaveBeenCalledWith({
			model: "gemini-2.5-pro",
			contents: [
				{ inlineData: { mimeType: "application/pdf", data: pdf.toString("base64") } },
				{ text: "extract" },
			],
		});
	});

	it("throws SAFETY_FILTER for a blocked prompt or a safety stop", async () => {
		await expect(
			geminiProvider({
				client: geminiClient({ promptFeedback: { blockReason: "SAFETY" } }),
			}).generate({ prompt: "x" }),
		).rejects.toMatchObject({ code: "SAFETY_FILTER" });
		await expect(
			geminiProvider({
				client: geminiClient({ candidates: [{ finishReason: "SAFETY" }] }),
			}).generate({
				prompt: "x",
			}),
		).rejects.toMatchObject({ code: "SAFETY_FILTER" });
	});

	it("embeds with the configured dimensions", async () => {
		const client = geminiClient();
		const vectors = await geminiProvider({ client, embeddingDimensions: 768 }).embed?.(["a"], {});
		expect(vectors).toEqual([[0.1, 0.2]]);
		expect(client.models.embedContent).toHaveBeenCalledWith({
			model: "gemini-embedding-001",
			contents: ["a"],
			config: { outputDimensionality: 768 },
		});
	});

	it("classifies SDK errors by message through the client", async () => {
		const client = geminiClient();
		client.models.generateContent.mockRejectedValueOnce(
			new Error('got status: 429 Too Many Requests. {"status":"RESOURCE_EXHAUSTED"}'),
		);
		const ai = createAI({
			providers: { gemini: { client } },
			default: "gemini",
			logger,
		});
		await expect(ai.generateText("x")).rejects.toMatchObject({
			code: "QUOTA_EXCEEDED",
			provider: "gemini",
		});
	});
});

describe("openaiProvider", () => {
	it("sends a text prompt through chat completions", async () => {
		const client = openaiClient();
		const res = await openaiProvider({ client }).generate({
			prompt: "hi",
			system: "sys",
			jsonMode: true,
			temperature: 0.5,
			maxTokens: 7,
		});
		expect(client.chat.completions.create).toHaveBeenCalledWith({
			model: "gpt-4o-mini",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
			],
			temperature: 0.5,
			max_completion_tokens: 7,
			response_format: { type: "json_object" },
		});
		expect(res).toMatchObject({
			text: "chat",
			model: "gpt-4o-mini",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		});
	});

	it("sends a PDF as an input_file to the Responses API with the file model", async () => {
		const client = openaiClient();
		const res = await openaiProvider({ client }).generate({
			prompt: "extract",
			jsonMode: true,
			system: "sys",
			file: { data: pdf, mimeType: "application/pdf" },
		});
		expect(client.responses.create).toHaveBeenCalledWith({
			model: "gpt-4o",
			instructions: "sys",
			text: { format: { type: "json_object" } },
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_file",
							filename: "document.pdf",
							file_data: `data:application/pdf;base64,${pdf.toString("base64")}`,
						},
						{ type: "input_text", text: "extract" },
					],
				},
			],
		});
		expect(client.chat.completions.create).not.toHaveBeenCalled();
		expect(res).toMatchObject({ text: "file", model: "gpt-4o", usage: { totalTokens: 120 } });
	});

	it("sends an image as an input_image", async () => {
		const client = openaiClient();
		const png = new Uint8Array([137, 80, 78, 71]);
		await openaiProvider({ client }).generate({
			prompt: "what is it",
			file: { data: png, mimeType: "image/png" },
			model: "gpt-4.1",
		});
		expect(client.responses.create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "gpt-4.1",
				input: [
					{
						role: "user",
						content: [
							{
								type: "input_image",
								image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
								detail: "auto",
							},
							{ type: "input_text", text: "what is it" },
						],
					},
				],
			}),
		);
	});

	it("throws SAFETY_FILTER on a content_filter stop", async () => {
		await expect(
			openaiProvider({ client: openaiClient("content_filter") }).generate({ prompt: "x" }),
		).rejects.toMatchObject({ code: "SAFETY_FILTER" });
	});

	it("embeds with dimensions from the call over the config", async () => {
		const client = openaiClient();
		await openaiProvider({ client, embeddingDimensions: 1536 }).embed?.(["a"], { dimensions: 768 });
		expect(client.embeddings.create).toHaveBeenCalledWith({
			model: "text-embedding-3-small",
			input: ["a"],
			dimensions: 768,
		});
	});

	it("falls back from OpenAI billing to Gemini through the client", async () => {
		const oa = openaiClient();
		oa.chat.completions.create.mockRejectedValueOnce(
			Object.assign(new Error("You exceeded your current quota"), {
				status: 429,
				code: "insufficient_quota",
			}),
		);
		const ai = createAI({
			providers: { openai: { client: oa }, gemini: { client: geminiClient() } },
			default: "openai",
			fallback: "gemini",
			logger,
		});
		const res = await ai.generateText("hi");
		expect(res).toMatchObject({ provider: "gemini", text: "ok", model: "gemini-2.5-flash" });
		expect(res.costUsd).toBe(0.000016);
	});
});
