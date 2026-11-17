/** What `deliverEvents` needs of the app's `createEvents(…)` from @tatara/events. */
export interface DeliverableEvents {
	flush(): Promise<number>;
	relay(): Promise<number>;
}

export interface DeliverEventsOptions {
	events: DeliverableEvents;
	/** runs the jobs the relay enqueued, e.g. `(jobs.driver as InlineDriver).drain()` */
	drain?: () => Promise<void>;
	/** default 50 */
	maxRounds?: number;
}

/**
 * Delivers every committed domain event to its subscribers, and the events they emit in turn: runs
 * the jobs, waits for post-commit publishes, relays what they missed, until a round finds nothing.
 */
export async function deliverEvents(options: DeliverEventsOptions): Promise<void> {
	const { events, drain } = options;
	const maxRounds = options.maxRounds ?? 50;
	for (let round = 0; round < maxRounds; round++) {
		await drain?.();
		// a publish enqueues a job and a relay enqueues jobs: either means another round
		const flushed = await events.flush();
		const relayed = await events.relay();
		if (flushed === 0 && relayed === 0) return;
	}
	throw new Error(`domain events kept arriving after ${maxRounds} rounds`);
}
