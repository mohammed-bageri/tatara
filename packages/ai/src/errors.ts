export type AIErrorCode =
	| "QUOTA_EXCEEDED"
	| "BILLING_ERROR"
	| "MODEL_UNAVAILABLE"
	| "SAFETY_FILTER"
	| "INVALID_API_KEY"
	| "INVALID_RESPONSE"
	| "AI_ERROR";

/**
 * `exhaustion`: another provider may succeed (the only kind that falls back).
 * `safety`: the input was refused. `auth`: missing or bad key. `other`: anything else.
 */
export type AIErrorKind = "exhaustion" | "safety" | "auth" | "other";

const KINDS: Record<AIErrorCode, AIErrorKind> = {
	QUOTA_EXCEEDED: "exhaustion",
	BILLING_ERROR: "exhaustion",
	MODEL_UNAVAILABLE: "exhaustion",
	SAFETY_FILTER: "safety",
	INVALID_API_KEY: "auth",
	INVALID_RESPONSE: "other",
	AI_ERROR: "other",
};

const STATUS: Record<AIErrorCode, number> = {
	QUOTA_EXCEEDED: 429,
	BILLING_ERROR: 402,
	MODEL_UNAVAILABLE: 503,
	SAFETY_FILTER: 422,
	INVALID_API_KEY: 500,
	INVALID_RESPONSE: 502,
	AI_ERROR: 503,
};

export interface AIErrorOptions {
	/** HTTP status an API should answer with; defaults by code */
	statusCode?: number;
	provider?: string;
	cause?: unknown;
}

export class AIError extends Error {
	readonly code: AIErrorCode;
	readonly statusCode: number;
	/** The provider that failed; set by the client when a provider leaves it out */
	provider: string | undefined;

	constructor(message: string, code: AIErrorCode, options: AIErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AIError";
		this.code = code;
		this.statusCode = options.statusCode ?? STATUS[code];
		this.provider = options.provider;
	}

	get kind(): AIErrorKind {
		return KINDS[this.code];
	}
}

export function isAIError(error: unknown, code?: AIErrorCode): error is AIError {
	return error instanceof AIError && (code === undefined || error.code === code);
}

/** Quota, billing or model-unavailable: worth trying another provider. */
export function isExhaustionError(error: unknown): error is AIError {
	return error instanceof AIError && error.kind === "exhaustion";
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function field(error: unknown, key: string): unknown {
	return typeof error === "object" && error !== null
		? (error as Record<string, unknown>)[key]
		: undefined;
}

/** Network blips and 5xx: retried on the same provider before the error is classified. */
export function isTransientError(error: unknown): boolean {
	if (error instanceof AIError) return false;
	const status = field(error, "status");
	if (typeof status === "number" && (status >= 500 || status === 408)) return true;
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	return ["network", "fetch", "econnreset", "timeout", "500", "502", "503", "504"].some((s) =>
		msg.includes(s),
	);
}

/** Classifies by error message; how Gemini's SDK reports failures. */
export function classifyByMessage(error: unknown, label = "AI provider"): AIError {
	if (error instanceof AIError) return error;
	const msg = message(error).toLowerCase();
	const make = (text: string, code: AIErrorCode) => new AIError(text, code, { cause: error });
	if (
		msg.includes("api_key_invalid") ||
		msg.includes("api key not valid") ||
		msg.includes("invalid api key") ||
		msg.includes("unauthenticated")
	) {
		return make(`Invalid ${label} API key. Please check your configuration.`, "INVALID_API_KEY");
	}
	if (
		msg.includes("quota") ||
		msg.includes("resource_exhausted") ||
		msg.includes("429") ||
		msg.includes("rate limit") ||
		msg.includes("too many requests")
	) {
		return make(
			"AI generation quota exceeded. Please try again later or upgrade your plan.",
			"QUOTA_EXCEEDED",
		);
	}
	if (
		msg.includes("billing") ||
		msg.includes("payment") ||
		msg.includes("credit") ||
		msg.includes("insufficient")
	) {
		return make(
			"AI generation is unavailable due to a billing issue. Please check your API credits.",
			"BILLING_ERROR",
		);
	}
	if (msg.includes("safety") || msg.includes("blocked") || msg.includes("harm")) {
		return make(
			"AI generation was blocked by safety filters. Please revise your input.",
			"SAFETY_FILTER",
		);
	}
	if (msg.includes("model") && (msg.includes("not found") || msg.includes("unavailable"))) {
		return make("AI model is currently unavailable. Please try again later.", "MODEL_UNAVAILABLE");
	}
	return make(`AI generation failed: ${message(error)}`, "AI_ERROR");
}

/** Classifies by HTTP `status` and `code`; how OpenAI's SDK reports failures. */
export function classifyByStatus(error: unknown, label = "AI provider"): AIError {
	if (error instanceof AIError) return error;
	const status = field(error, "status");
	const code = field(error, "code");
	const msg = message(error).toLowerCase();
	const make = (text: string, c: AIErrorCode) => new AIError(text, c, { cause: error });
	if (status === 401 || code === "invalid_api_key" || msg.includes("invalid api key")) {
		return make(`Invalid ${label} API key. Please check your configuration.`, "INVALID_API_KEY");
	}
	if (
		status === 429 &&
		(code === "insufficient_quota" || msg.includes("quota") || msg.includes("billing"))
	) {
		return make(
			`AI generation is unavailable due to insufficient ${label} credits. Please top up your account.`,
			"BILLING_ERROR",
		);
	}
	if (status === 429) {
		return make(
			"AI generation rate limit reached. Please try again in a moment.",
			"QUOTA_EXCEEDED",
		);
	}
	if (
		status === 400 &&
		(code === "content_filter" || msg.includes("content_filter") || msg.includes("safety"))
	) {
		return make(
			"AI generation was blocked by content filters. Please revise your input.",
			"SAFETY_FILTER",
		);
	}
	if (status === 404 && code === "model_not_found") {
		return make("AI model is currently unavailable. Please try again later.", "MODEL_UNAVAILABLE");
	}
	if (typeof status === "number" && status >= 500) {
		return make(
			`${label} is temporarily unavailable. Please try again later.`,
			"MODEL_UNAVAILABLE",
		);
	}
	return make(`AI generation failed: ${message(error)}`, "AI_ERROR");
}

/** Default for providers without their own `classifyError`: by status when there is one. */
export function classifyError(error: unknown, label?: string): AIError {
	return typeof field(error, "status") === "number"
		? classifyByStatus(error, label)
		: classifyByMessage(error, label);
}

/** True when the model refused the prompt itself (a safety block), not when a request failed. */
export function isBlockedResponse(error: unknown): error is AIError {
	return error instanceof AIError && error.code === "SAFETY_FILTER" && error.cause === undefined;
}
