type Translate = (key: string) => string;

/**
 * A copy of `data` with a `<field>_label` for each field in `enumMap` that has a value:
 * `enumMap` maps a field to its key prefix, so `{ status: "jobs:status" }` reads `jobs:status.DRAFT`.
 */
export function withEnumLabels<T extends Record<string, unknown>>(
	data: T,
	enumMap: Record<string, string>,
	t: Translate,
): T & Record<string, unknown> {
	const result: Record<string, unknown> = { ...data };
	for (const [field, prefix] of Object.entries(enumMap)) {
		const value = data[field];
		if (value !== undefined && value !== null) result[`${field}_label`] = t(`${prefix}.${value}`);
	}
	return result as T & Record<string, unknown>;
}

/** `withEnumLabels` for every item. */
export function withEnumLabelsAll<T extends Record<string, unknown>>(
	items: T[],
	enumMap: Record<string, string>,
	t: Translate,
): Array<T & Record<string, unknown>> {
	return items.map((item) => withEnumLabels(item, enumMap, t));
}
