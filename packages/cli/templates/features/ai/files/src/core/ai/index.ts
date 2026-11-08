import { createAI } from "@tatara/ai";
import { env } from "#core/config/env";
import { logger } from "#core/logging/logger";

export { AIError } from "@tatara/ai";

/** The app's AI client; a provider without an API key is skipped as the fallback. */
export const ai = createAI({
	providers: {
		gemini: { apiKey: env.GEMINI_API_KEY },
		openai: { apiKey: env.OPENAI_API_KEY },
	},
	default: env.AI_DEFAULT_PROVIDER,
	fallback: env.AI_FALLBACK_PROVIDER,
	cooldownMs: env.AI_PROVIDER_COOLDOWN_MS,
	logger,
});
