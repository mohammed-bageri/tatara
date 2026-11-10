/** @tatara/ai: one AI client over Gemini and OpenAI with fallback, cost estimates, JSON and embeddings. */
export {
	type AI,
	type AIConfig,
	type AIEmbeddings,
	type AIJsonResponse,
	type AILogger,
	type AIProviders,
	type AIResponse,
	type AISchema,
	createAI,
	type EmbedOptions,
	type GenerateOptions,
	type ProviderName,
} from "./client.ts";
export {
	AIError,
	type AIErrorCode,
	type AIErrorKind,
	type AIErrorOptions,
	classifyByMessage,
	classifyByStatus,
	classifyError,
	isAIError,
	isBlockedResponse,
	isExhaustionError,
	isTransientError,
} from "./errors.ts";
export {
	classifyGeminiError,
	type GeminiClient,
	type GeminiOptions,
	geminiProvider,
} from "./gemini.ts";
export { parseAiJson } from "./json.ts";
export {
	classifyOpenAIError,
	type OpenAIClient,
	type OpenAIOptions,
	openaiProvider,
} from "./openai.ts";
export { DEFAULT_PRICING, estimateCostUsd, type ModelPrice, type PricingTable } from "./pricing.ts";
export type { AIFileInput, AIProvider, AIProviderResult, AIRequest, AIUsage } from "./types.ts";
export { cosineSimilarity } from "./vector.ts";
