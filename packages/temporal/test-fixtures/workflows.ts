import { proxyActivities } from "@temporalio/workflow";

const { greet } = proxyActivities<{ greet(name: string): Promise<string> }>({
	startToCloseTimeout: "10 seconds",
});

export async function greeting(name: string): Promise<string> {
	return greet(name);
}
