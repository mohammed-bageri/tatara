// biome-ignore lint/suspicious/noExplicitAny: an activity takes and returns whatever it declares
type ActivityFn = (...args: any[]) => Promise<unknown>;
export type ActivitySet = Record<string, ActivityFn>;

type Merge<T extends readonly ActivitySet[]> = T extends readonly [
	infer Head extends ActivitySet,
	...infer Tail extends readonly ActivitySet[],
]
	? Head & Merge<Tail>
	: Record<never, never>;

/** Default export of every `activities/*.ts`: the activities that module gives the worker. */
export function defineActivities<const A extends ActivitySet>(activities: A): A {
	return activities;
}

/** One activity map from every module's set; two activities with one name is a registration bug. */
export function mergeActivities<const T extends readonly ActivitySet[]>(...sets: T): Merge<T> {
	const merged: ActivitySet = {};
	for (const set of sets) {
		for (const [name, fn] of Object.entries(set)) {
			if (name in merged) throw new Error(`Duplicate activity "${name}"`);
			merged[name] = fn;
		}
	}
	return merged as Merge<T>;
}
