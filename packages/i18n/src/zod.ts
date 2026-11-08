import type { I18n } from "./index.ts";

/** The fields of a zod issue the messages use; zod's own issue type is assignable to it. */
export interface ZodIssueLike {
	code?: string;
	input?: unknown;
	expected?: unknown;
	minimum?: unknown;
	maximum?: unknown;
	values?: readonly unknown[];
}

export type ZodMessageKind =
	| "required"
	| "invalid_type"
	| "too_small"
	| "too_big"
	| "invalid_format"
	| "invalid_value"
	| "custom";

export interface ZodErrorMapOptions {
	/** key prefix; a message's key is `${prefix}${kind}` (default "validation.") */
	prefix?: string;
	/** full keys for some kinds, overriding the prefix */
	keys?: Partial<Record<ZodMessageKind, string>>;
}

function describe(issue: ZodIssueLike): [ZodMessageKind, Record<string, unknown>] | undefined {
	switch (issue.code) {
		case "invalid_type":
			return issue.input === undefined
				? ["required", {}]
				: ["invalid_type", { expected: issue.expected, received: typeof issue.input }];
		case "too_small":
			return ["too_small", { minimum: String(issue.minimum) }];
		case "too_big":
			return ["too_big", { maximum: String(issue.maximum) }];
		case "invalid_format":
			return ["invalid_format", {}];
		case "invalid_value":
			return ["invalid_value", { options: (issue.values ?? []).map(String).join(", ") }];
		case "custom":
			return ["custom", {}];
		default:
			return undefined;
	}
}

/**
 * A zod error map giving messages in `i18n.currentLanguage()` (the request's language under
 * `detectLanguage`). Register it once: `z.config({ customError: zodErrorMap(i18n) })`.
 * Kinds without a translation keep zod's own message.
 */
export function zodErrorMap(i18n: I18n, options: ZodErrorMapOptions = {}) {
	const prefix = options.prefix ?? "validation.";
	return (issue: ZodIssueLike): { message: string } | undefined => {
		const described = describe(issue);
		if (!described) return undefined;
		const [kind, vars] = described;
		const key = options.keys?.[kind] ?? `${prefix}${kind}`;
		const language = i18n.currentLanguage();
		if (!i18n.exists(key, language)) return undefined;
		return { message: i18n.t(language, key, key, vars) };
	};
}
