import type OpenAI from "openai";
import { AIError, classifyByStatus } from "./errors.ts";
import type { AIProvider, AIRequest } from "./types.ts";

type ChatParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
type ResponseParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type EmbeddingParams = OpenAI.Embeddings.EmbeddingCreateParams;

/** The part of the `OpenAI` client the provider calls; pass one as `client` to reuse or fake it. */
export interface OpenAIClient {
	chat: {
		completions: {
			create(params: ChatParams): Promise<{
				choices: { message?: { content?: string | null }; finish_reason?: string | null }[];
				usage?:
					| { prompt_tokens: number; completion_tokens: number; total_tokens: number }
					| undefined;
			}>;
		};
	};
	responses: {
		create(params: ResponseParams): Promise<{
			output_text?: string;
			usage?: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
		}>;
	};
	embeddings: {
		create(params: EmbeddingParams): Promise<{ data: { embedding: number[] }[] }>;
	};
}

export interface OpenAIOptions {
	/** Unset or empty: the provider counts as not configured */
	apiKey?: string | undefined;
	baseURL?: string;
	/** Default "gpt-4o-mini", for text prompts */
	model?: string;
	/** Default "gpt-4o", for prompts with a file (Responses API) */
	fileModel?: string;
	/** Default "text-embedding-3-small". Changing it invalidates every stored vector. */
	embeddingModel?: string;
	/** Output dimensions for `embed`; the model's native size when unset */
	embeddingDimensions?: number;
	client?: OpenAIClient;
}

export function classifyOpenAIError(error: unknown): AIError {
	return classifyByStatus(error, "OpenAI");
}

function filePart(file: NonNullable<AIRequest["file"]>) {
	const dataUrl = `data:${file.mimeType};base64,${Buffer.from(file.data).toString("base64")}`;
	if (file.mimeType.startsWith("image/")) {
		return { type: "input_image" as const, image_url: dataUrl, detail: "auto" as const };
	}
	const ext = file.mimeType.split("/")[1] ?? "pdf";
	return { type: "input_file" as const, filename: `document.${ext}`, file_data: dataUrl };
}

export function openaiProvider(options: OpenAIOptions): AIProvider {
	const model = options.model ?? "gpt-4o-mini";
	const fileModel = options.fileModel ?? "gpt-4o";
	const embeddingModel = options.embeddingModel ?? "text-embedding-3-small";
	let client: Promise<OpenAIClient> | undefined = options.client
		? Promise.resolve(options.client)
		: undefined;
	const getClient = () => {
		client ??= import("openai").then(
			({ default: OpenAISdk }) =>
				new OpenAISdk({
					apiKey: options.apiKey,
					...(options.baseURL ? { baseURL: options.baseURL } : {}),
				}),
		);
		return client;
	};

	return {
		configured: Boolean(options.apiKey) || options.client !== undefined,
		label: "OpenAI",
		embeddingModel,
		classifyError: classifyOpenAIError,
		async generate(request) {
			const sdk = await getClient();
			if (request.file) {
				// Responses API: native PDF and image understanding
				const used = request.model ?? fileModel;
				const params: ResponseParams = {
					model: used,
					input: [
						{
							role: "user",
							content: [filePart(request.file), { type: "input_text", text: request.prompt }],
						},
					],
				};
				if (request.system !== undefined) params.instructions = request.system;
				if (request.temperature !== undefined) params.temperature = request.temperature;
				if (request.maxTokens !== undefined) params.max_output_tokens = request.maxTokens;
				if (request.jsonMode) params.text = { format: { type: "json_object" } };
				const response = await sdk.responses.create(params);
				const u = response.usage;
				return {
					text: response.output_text ?? "",
					model: used,
					usage: u
						? {
								promptTokens: u.input_tokens,
								completionTokens: u.output_tokens,
								totalTokens: u.total_tokens,
							}
						: undefined,
					raw: response,
				};
			}

			const used = request.model ?? model;
			const params: ChatParams = {
				model: used,
				messages: [
					...(request.system === undefined
						? []
						: [{ role: "system" as const, content: request.system }]),
					{ role: "user", content: request.prompt },
				],
			};
			if (request.temperature !== undefined) params.temperature = request.temperature;
			if (request.maxTokens !== undefined) params.max_completion_tokens = request.maxTokens;
			if (request.jsonMode) params.response_format = { type: "json_object" };
			const completion = await sdk.chat.completions.create(params);
			const choice = completion.choices[0];
			if (choice?.finish_reason === "content_filter") {
				throw new AIError(
					"AI generation was blocked by content filters. Please revise your input.",
					"SAFETY_FILTER",
				);
			}
			const u = completion.usage;
			return {
				text: choice?.message?.content ?? "",
				model: used,
				usage: u
					? {
							promptTokens: u.prompt_tokens,
							completionTokens: u.completion_tokens,
							totalTokens: u.total_tokens,
						}
					: undefined,
				raw: completion,
			};
		},
		async embed(texts, { dimensions }) {
			const size = dimensions ?? options.embeddingDimensions;
			const res = await (await getClient()).embeddings.create({
				model: embeddingModel,
				input: texts,
				...(size === undefined ? {} : { dimensions: size }),
			});
			return res.data.map((d) => d.embedding);
		},
	};
}
