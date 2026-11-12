import { proxyActivities } from "@temporalio/workflow";
import type { Activities } from "#generated/activities";

// pick the activities this workflow calls, e.g. const { sendInvoice } = proxyActivities<Activities>(…)
const activities = proxyActivities<Activities>({ startToCloseTimeout: "1 minute" });

/**
 * Deterministic orchestration only: call activities for I/O, use sleep/condition/signals from
 * @temporalio/workflow for waiting. The exported name is the workflow type, unique in the app.
 */
export async function __moduleCamel____namePascal__(id: string): Promise<void> {
	void activities;
	void id;
}
