import type { EmbedContentParameters, GenerateContentParameters } from "@google/genai";
import { AIError, classifyByMessage } from "./errors.ts";
import type { AIProvider, AIRequest } from "./types.ts";

/** The part of `GoogleGenAI` the provider calls; pass one as `client` to reuse or fake it. */
export interface GeminiClient {
	models: {
		generateContent(params: GenerateContentParameters): Promise<{
			text?: string | undefined;
			usageMetadata?:
				| {
						promptTokenCount?: number | undefined;
						candidatesTokenCount?: number | undefined;
						totalTokenCount?: number | undefined;
				  }
				| undefined;
			promptFeedback?: { blockReason?: string | undefined } | undefined;
			candidates?: { finishReason?: string | undefined }[] | undefined;
		}>;
		embedContent(params: EmbedContentParameters): Promise<{
			embeddings?: { values?: number[] | undefined }[] | undefined;
		}>;
	};
}

export interface GeminiOptions {
	/** Unset or empty: the provider counts as not configured */
	apiKey?: string | undefined;
	/** Default "gemini-2.5-flash"; handles text and files */
	model?: string;
	/** Default "gemini-embedding-001". Changing it invalidates every stored vector. */
	embeddingModel?: string;
	/** Output dimensions for `embed`; the model's native size when unset */
	embeddingDimensions?: number;
	client?: GeminiClient;
}

const SAFETY_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

export function classifyGeminiError(error: unknown): AIError {
	return classifyByMessage(error, "Gemini");
}

function contents(request: AIRequest): GenerateContentParameters["contents"] {
	if (!request.file) return request.prompt;
	return [
		{
			inlineData: {
				mimeType: request.file.mimeType,
				data: Buffer.from(request.file.data).toString("base64"),
			},
		},
		{ text: request.prompt },
	];
}

export function geminiProvider(options: GeminiOptions): AIProvider {
	const model = options.model ?? "gemini-2.5-flash";
	const embeddingModel = options.embeddingModel ?? "gemini-embedding-001";
	let client: Promise<GeminiClient> | undefined = options.client
		? Promise.resolve(options.client)
		: undefined;
	const getClient = () => {
		client ??= import("@google/genai").then(
			({ GoogleGenAI }) => new GoogleGenAI({ apiKey: options.apiKey ?? "" }),
		);
		return client;
	};

	return {
		configured: Boolean(options.apiKey) || options.client !== undefined,
		label: "Gemini",
		embeddingModel,
		classifyError: classifyGeminiError,
		async generate(request) {
			const used = request.model ?? model;
			const config: NonNullable<GenerateContentParameters["config"]> = {};
			if (request.jsonMode) config.responseMimeType = "application/json";
			if (request.system !== undefined) config.systemInstruction = request.system;
			if (request.temperature !== undefined) config.temperature = request.temperature;
			if (request.maxTokens !== undefined) config.maxOutputTokens = request.maxTokens;
			const response = await (await getClient()).models.generateContent({
				model: used,
				contents: contents(request),
				...(Object.keys(config).length ? { config } : {}),
			});
			const blocked =
				response.promptFeedback?.blockReason ??
				(SAFETY_FINISH.has(response.candidates?.[0]?.finishReason ?? "")
					? response.candidates?.[0]?.finishReason
					: undefined);
			if (blocked) {
				throw new AIError(
					`AI generation was blocked by safety filters (${blocked}). Please revise your input.`,
					"SAFETY_FILTER",
				);
			}
			const u = response.usageMetadata;
			const promptTokens = u?.promptTokenCount ?? 0;
			const completionTokens = u?.candidatesTokenCount ?? 0;
			return {
				text: response.text ?? "",
				model: used,
				usage: u
					? {
							promptTokens,
							completionTokens,
							totalTokens: u.totalTokenCount ?? promptTokens + completionTokens,
						}
					: undefined,
				raw: response,
			};
		},
		async embed(texts, { dimensions }) {
			const size = dimensions ?? options.embeddingDimensions;
			const res = await (await getClient()).models.embedContent({
				model: embeddingModel,
				contents: texts,
				...(size === undefined ? {} : { config: { outputDimensionality: size } }),
			});
			return (res.embeddings ?? []).map((e) => e.values ?? []);
		},
	};
}
