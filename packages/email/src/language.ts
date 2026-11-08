/** A recipient's language, from the app's sources in priority order. */

/** One source, e.g. the user's account or a candidate record; null defers to the next one. */
export interface LanguageResolver<Ref = Record<string, unknown>> {
	/** lower runs first; default 0, ties keep their order */
	priority?: number;
	resolve(orgId: string, address: string, ref: Ref): Promise<string | null> | string | null;
}

export function createLanguageResolver<Ref = Record<string, unknown>>(
	resolvers: readonly LanguageResolver<Ref>[],
	options: { fallback?: string } = {},
): (orgId: string, address: string, ref?: Ref) => Promise<string> {
	const ordered = resolvers
		.map((r, i) => ({ r, i }))
		.sort((a, b) => (a.r.priority ?? 0) - (b.r.priority ?? 0) || a.i - b.i)
		.map(({ r }) => r);
	const fallback = options.fallback ?? "en";
	return async (orgId, address, ref = {} as Ref) => {
		for (const resolver of ordered) {
			const language = await resolver.resolve(orgId, address, ref);
			if (language) return language;
		}
		return fallback;
	};
}
