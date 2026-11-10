# @tatara/ai

## 0.1.1

### Patch Changes

- 9b9ac7f: The repository moved to github.com/mohammed-bageri/tatara (was tatara-cli); package metadata and docs point there.

## 0.1.0

### Minor Changes

- 855ba4f: `@tatara/ai`: one AI client over Gemini and OpenAI. `createAI({ providers, default, fallback, cooldownMs, logger, pricing })` with `generateText` (system, JSON mode, native PDF/image input, model, temperature, max tokens), `generateJson` (tolerant parse, optional schema) and `embed`. Falls back only on exhaustion errors (quota, billing, model unavailable) and tries an exhausted provider last for a cooldown window; reports who answered, usage and an estimated cost from an extensible pricing table. Typed `AIError` with `code` and `kind` (exhaustion, safety, auth, other). `@google/genai` and `openai` are optional peers. New `ai` add-on: `src/core/ai/index.ts` and the `AI_*`, `GEMINI_API_KEY` and `OPENAI_API_KEY` env vars.
