/**
 * Parses a model's JSON answer. Models wrap JSON in ``` fences or add prose even in JSON mode,
 * so this strips fences and, failing that, takes the outermost {...} / [...] span.
 * Throws SyntaxError when there is no JSON.
 */
export function parseAiJson<T = unknown>(text: string): T {
	let s = text.trim();
	if (s.startsWith("```")) {
		s = s
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/\s*```$/, "")
			.trim();
	}
	try {
		return JSON.parse(s) as T;
	} catch {
		const starts = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
		const start = starts.length ? Math.min(...starts) : -1;
		const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
		if (start >= 0 && end > start) {
			return JSON.parse(s.slice(start, end + 1)) as T;
		}
		throw new SyntaxError("No JSON object/array found in AI response");
	}
}
