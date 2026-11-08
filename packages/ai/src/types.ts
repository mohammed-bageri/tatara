import type { AIError } from "./errors.ts";

/** A PDF or image sent as raw bytes, read by the model natively (Arabic/RTL and scans included). */
export interface AIFileInput {
	data: Uint8Array;
	mimeType: string;
}

export interface AIUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

/** What the client hands a provider for one call. */
export interface AIRequest {
	prompt: string;
	system?: string;
	jsonMode?: boolean;
	file?: AIFileInput;
	/** The provider's default (or file) model when unset */
	model?: string;
	temperature?: number;
	maxTokens?: number;
}

export interface AIProviderResult {
	text: string;
	/** The model that answered */
	model: string;
	usage?: AIUsage;
	raw: unknown;
}

/**
 * One AI backend. `geminiProvider` and `openaiProvider` implement it; pass your own (or a fake
 * in tests) under any name in `createAI({ providers })`.
 */
export interface AIProvider {
	/** false when there is no API key: skipped as a fallback, refused as the primary */
	readonly configured: boolean;
	/** Used in error messages */
	readonly label?: string;
	generate(request: AIRequest): Promise<AIProviderResult>;
	readonly embeddingModel?: string;
	embed?(texts: string[], options: { dimensions?: number }): Promise<number[][]>;
	/** Maps an SDK error to an AIError; `classifyError` when unset */
	classifyError?(error: unknown): AIError;
}
