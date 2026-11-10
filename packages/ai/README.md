# @tatara/ai

Part of [tatara](https://github.com/mohammed-bageri/tatara). `tatara new --addons ai` wires it up.

One AI client over Gemini and OpenAI: a default provider, a fallback when the default runs out,
native PDF/image input, JSON mode, embeddings and per-call cost estimates. The SDKs are optional
peers: install `@google/genai` for Gemini and `openai` for OpenAI.

## Use

```ts
import { createAI } from "@tatara/ai";

export const ai = createAI({
	providers: {
		gemini: { apiKey: env.GEMINI_API_KEY }, // model, embeddingModel, embeddingDimensions, client
		openai: { apiKey: env.OPENAI_API_KEY }, // + fileModel, baseURL
	},
	default: "gemini",
	fallback: "openai", // optional
	cooldownMs: 60_000, // default
	logger, // pino fits: logger.warn(obj, msg)
	pricing: { "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 } }, // merged over DEFAULT_PRICING
});

const res = await ai.generateText(prompt, {
	system, jsonMode, temperature, maxTokens,
	model, // the first provider only; a fallback uses its own default
	provider: "openai", // start here instead of the default
	file: { data: buffer, mimeType: "application/pdf" },
});
res.text; res.provider; res.model; res.usage; res.costUsd; res.raw;

const { data } = await ai.generateJson(prompt, zodSchema); // JSON mode, tolerant parse, validate
const { embeddings, model } = await ai.embed(texts, { dimensions: 768 });
```

**Files.** PDFs and images go to the model as raw bytes (Gemini `inlineData`, OpenAI Responses
`input_file` / `input_image` with `fileModel`, default `gpt-4o`). The model reads them natively,
which is the only approach that handles Arabic/RTL text and scanned documents. Don't extract
text first.

**Defaults.** Gemini `gemini-2.5-flash` and `gemini-embedding-001`; OpenAI `gpt-4o-mini`, `gpt-4o`
for files, `text-embedding-3-small`. Changing an embedding model invalidates stored vectors, and
`embed` never falls back for the same reason.

## Fallback and errors

Every failure is an `AIError` with a `code`, a `kind`, a `statusCode` and the `provider`:

| kind | codes | falls back |
|---|---|---|
| `exhaustion` | `QUOTA_EXCEEDED`, `BILLING_ERROR`, `MODEL_UNAVAILABLE` | yes |
| `safety` | `SAFETY_FILTER` | no |
| `auth` | `INVALID_API_KEY` (also: no key configured) | no |
| `other` | `INVALID_RESPONSE` (JSON), `AI_ERROR` | no |

Network errors and 5xx are retried on the same provider first (`retryDelaysMs`, default
1s/2s/4s). After an exhaustion error the provider goes to the back of the line for `cooldownMs`,
so later calls go straight to the fallback; it stays as the last resort. The state is per
instance and in memory. A fallback without an API key is skipped. Read `res.provider` to know
who answered.

## Your own provider

Any name in `providers` can take an `AIProvider`: `{ configured, generate(request), embed?,
embeddingModel?, classifyError?, label? }`. Tests use one as a fake, so no test calls a network.
`geminiProvider` and `openaiProvider` take a `client` to reuse or fake the SDK.

Also exported: `parseAiJson`, `cosineSimilarity`, `estimateCostUsd`, `DEFAULT_PRICING`, the
classifiers (`classifyGeminiError`, `classifyOpenAIError`, `classifyError`), `isAIError`,
`isExhaustionError`, `isTransientError`.

## Tests

Unit tests use fake providers and fake SDK clients. `TATARA_TEST_GEMINI_API_KEY` /
`TATARA_TEST_OPENAI_API_KEY` turn on `src/live.test.ts`, which calls the real APIs.
