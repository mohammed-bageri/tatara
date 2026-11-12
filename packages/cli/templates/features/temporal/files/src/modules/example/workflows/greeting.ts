import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "#generated/activities";

const { composeGreeting } = proxyActivities<Activities>({ startToCloseTimeout: "1 minute" });

/** Workflow code is deterministic: it only orchestrates; activities do the work. */
export async function exampleGreeting(name: string): Promise<string> {
	return await composeGreeting(name);
}
