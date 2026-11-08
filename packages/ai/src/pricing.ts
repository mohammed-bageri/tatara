/** USD per 1,000,000 tokens. */
export interface ModelPrice {
	inputPerMillion: number;
	outputPerMillion: number;
}

export type PricingTable = Record<string, ModelPrice>;

/**
 * List prices for the providers' default models. An estimate for monitoring spend, not a
 * billing source of truth; pass `pricing` to `createAI` to add or override rows.
 */
export const DEFAULT_PRICING: Readonly<PricingTable> = Object.freeze({
	"gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
	"gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
	"text-embedding-3-small": { inputPerMillion: 0.02, outputPerMillion: 0 },
	"gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
	"gemini-2.5-flash-lite": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
});

/** Estimated USD cost, rounded to 6 decimals; `null` for a model with no price (never a fake 0). */
export function estimateCostUsd(
	pricing: PricingTable,
	model: string | undefined,
	promptTokens: number,
	completionTokens: number,
): number | null {
	const price = model === undefined ? undefined : pricing[model];
	if (!price) return null;
	const cost =
		(promptTokens / 1_000_000) * price.inputPerMillion +
		(completionTokens / 1_000_000) * price.outputPerMillion;
	return Math.round(cost * 1_000_000) / 1_000_000;
}
