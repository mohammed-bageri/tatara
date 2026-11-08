import { AIError, classifyError, isExhaustionError, isTransientError } from "./errors.ts";
import { type GeminiOptions, geminiProvider } from "./gemini.ts";
import { parseAiJson } from "./json.ts";
import { type OpenAIOptions, openaiProvider } from "./openai.ts";
import { DEFAULT_PRICING, estimateCostUsd, type PricingTable } from "./pricing.ts";
import type { AIFileInput, AIProvider, AIRequest, AIUsage } from "./types.ts";

/** pino's `logger.warn(obj, msg)` fits. */
export interface AILogger {
	warn(obj: object, msg: string): void;
}

/** Built-in providers take their options; any name can take a ready `AIProvider`. */
export interface AIProviders {
	gemini?: GeminiOptions | AIProvider;
	openai?: OpenAIOptions | AIProvider;
	[name: string]: GeminiOptions | OpenAIOptions | AIProvider | undefined;
}

export interface AIConfig<P extends AIProviders> {
	providers: P;
	default: ProviderName<P>;
	/** Tried when the provider in use fails with an exhaustion error; skipped without an API key */
	fallback?: ProviderName<P> | undefined;
	/** How long a provider that hit an exhaustion error is tried last. Default 60s; 0 disables. */
	cooldownMs?: number;
	/** Waits before retrying a network error or 5xx on the same provider. Default [1000, 2000, 4000]. */
	retryDelaysMs?: readonly number[];
	logger: AILogger;
	/** Merged over DEFAULT_PRICING */
	pricing?: PricingTable;
}

export type ProviderName<P extends AIProviders> = Extract<keyof P, string>;

export interface GenerateOptions<N extends string = string> {
	/** The first provider to try; the configured default when unset */
	provider?: N;
	system?: string;
	jsonMode?: boolean;
	file?: AIFileInput;
	/** Applies to the first provider only; a fallback uses its own default model */
	model?: string;
	temperature?: number;
	maxTokens?: number;
}

export interface AIResponse<N extends string = string> {
	text: string;
	/** Who answered; differs from the one asked when the fallback did */
	provider: N;
	model: string;
	usage?: AIUsage;
	/** From the pricing table; null when the model has no price or no usage was reported */
	costUsd: number | null;
	raw: unknown;
}

export interface AIJsonResponse<T, N extends string = string> extends AIResponse<N> {
	data: T;
}

/** zod schemas fit. */
export interface AISchema<T> {
	parse(value: unknown): T;
}

export interface EmbedOptions<N extends string = string> {
	provider?: N;
	dimensions?: number;
}

export interface AIEmbeddings<N extends string = string> {
	embeddings: number[][];
	provider: N;
	model: string | undefined;
}

export interface AI<N extends string = string> {
	generateText(prompt: string, options?: GenerateOptions<N>): Promise<AIResponse<N>>;
	/** JSON mode on; parses (tolerating fences and prose) and validates with `schema` when given */
	generateJson<T = unknown>(
		prompt: string,
		schema?: AISchema<T>,
		options?: Omit<GenerateOptions<N>, "jsonMode">,
	): Promise<AIJsonResponse<T, N>>;
	/** No fallback: vectors from different models are not comparable */
	embed(texts: string[], options?: EmbedOptions<N>): Promise<AIEmbeddings<N>>;
	resetCooldowns(): void;
}

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];

function isProvider(value: unknown): value is AIProvider {
	return typeof (value as AIProvider | undefined)?.generate === "function";
}

function build(name: string, value: GeminiOptions | OpenAIOptions | AIProvider): AIProvider {
	if (isProvider(value)) return value;
	if (name === "gemini") return geminiProvider(value as GeminiOptions);
	if (name === "openai") return openaiProvider(value as OpenAIOptions);
	throw new Error(
		`@tatara/ai: provider "${name}" must be an AIProvider (only gemini and openai take options)`,
	);
}

export function createAI<const P extends AIProviders>(config: AIConfig<P>): AI<ProviderName<P>> {
	type N = ProviderName<P>;
	const providers = new Map<string, AIProvider>();
	for (const [name, value] of Object.entries(config.providers)) {
		if (value !== undefined) providers.set(name, build(name, value));
	}
	for (const name of [config.default, config.fallback]) {
		if (name !== undefined && !providers.has(name)) {
			throw new Error(`@tatara/ai: provider "${name}" is not in providers`);
		}
	}
	const cooldownMs = config.cooldownMs ?? 60_000;
	const retryDelays = config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
	const pricing: PricingTable = { ...DEFAULT_PRICING, ...config.pricing };
	// per instance, in memory: each process learns on its own, at worst one wasted probe per window
	const cooldownUntil = new Map<string, number>();

	const inCooldown = (name: string) => {
		const until = cooldownUntil.get(name);
		if (until === undefined) return false;
		if (Date.now() >= until) {
			cooldownUntil.delete(name);
			return false;
		}
		return true;
	};

	const usable = (name: string): AIProvider => {
		const provider = providers.get(name);
		if (!provider) {
			throw new AIError(`AI provider "${name}" is not configured`, "INVALID_API_KEY", {
				provider: name,
			});
		}
		if (!provider.configured) {
			throw new AIError(`No API key configured for AI provider "${name}"`, "INVALID_API_KEY", {
				provider: name,
			});
		}
		return provider;
	};

	async function attempt<T>(name: string, provider: AIProvider, fn: () => Promise<T>): Promise<T> {
		let error: unknown;
		for (let i = 0; i <= retryDelays.length; i++) {
			try {
				return await fn();
			} catch (e) {
				error = e;
				if (i === retryDelays.length || !isTransientError(e)) break;
				await new Promise((resolve) => setTimeout(resolve, retryDelays[i]));
			}
		}
		const classified =
			error instanceof AIError
				? error
				: (provider.classifyError?.(error) ?? classifyError(error, provider.label ?? name));
		classified.provider ??= name;
		throw classified;
	}

	async function generateText(
		prompt: string,
		options: GenerateOptions<N> = {},
	): Promise<AIResponse<N>> {
		const first: string = options.provider ?? config.default;
		usable(first);
		const chain = [first];
		const fallback = config.fallback;
		if (fallback !== undefined && fallback !== first && providers.get(fallback)?.configured) {
			chain.push(fallback);
		}
		// a cooling provider goes last, kept as a last resort
		const ordered = [...chain.filter((p) => !inCooldown(p)), ...chain.filter((p) => inCooldown(p))];

		const { provider: _, model, ...rest } = options;
		for (let i = 0; i < ordered.length; i++) {
			const name = ordered[i] as string;
			const provider = providers.get(name) as AIProvider;
			const request: AIRequest = { ...rest, prompt };
			if (model !== undefined && name === first) request.model = model;
			try {
				const result = await attempt(name, provider, () => provider.generate(request));
				return {
					text: result.text,
					provider: name as N,
					model: result.model,
					...(result.usage ? { usage: result.usage } : {}),
					costUsd: result.usage
						? estimateCostUsd(
								pricing,
								result.model,
								result.usage.promptTokens,
								result.usage.completionTokens,
							)
						: null,
					raw: result.raw,
				};
			} catch (error) {
				const next = ordered[i + 1];
				if (!isExhaustionError(error)) throw error;
				if (cooldownMs > 0) cooldownUntil.set(name, Date.now() + cooldownMs);
				if (next === undefined) throw error;
				config.logger.warn(
					{ failed: name, next, code: error.code },
					"AI provider unavailable; trying next provider",
				);
			}
		}
		throw new Error("unreachable");
	}

	async function generateJson<T>(
		prompt: string,
		schema?: AISchema<T>,
		options: Omit<GenerateOptions<N>, "jsonMode"> = {},
	): Promise<AIJsonResponse<T, N>> {
		const response = await generateText(prompt, { ...options, jsonMode: true });
		let data: T;
		try {
			const parsed = parseAiJson<unknown>(response.text);
			data = schema ? schema.parse(parsed) : (parsed as T);
		} catch (cause) {
			throw new AIError("AI response was not the expected JSON", "INVALID_RESPONSE", {
				provider: response.provider,
				cause,
			});
		}
		return { ...response, data };
	}

	async function embed(texts: string[], options: EmbedOptions<N> = {}): Promise<AIEmbeddings<N>> {
		const name: string = options.provider ?? config.default;
		const provider = usable(name);
		const result = { provider: name as N, model: provider.embeddingModel };
		if (texts.length === 0) return { ...result, embeddings: [] };
		const embedFn = provider.embed?.bind(provider);
		if (!embedFn) {
			throw new AIError(`AI provider "${name}" does not support embeddings`, "AI_ERROR", {
				provider: name,
			});
		}
		const dimensions = options.dimensions;
		const embeddings = await attempt(name, provider, () =>
			embedFn(texts, dimensions === undefined ? {} : { dimensions }),
		);
		return { ...result, embeddings };
	}

	return { generateText, generateJson, embed, resetCooldowns: () => cooldownUntil.clear() };
}
