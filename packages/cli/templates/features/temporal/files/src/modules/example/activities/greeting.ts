import { defineActivities } from "@tatara/temporal";

export default defineActivities({
	// activities do the I/O; a retry runs them again, so keep them idempotent
	async composeGreeting(name: string): Promise<string> {
		return `Hello, ${name}!`;
	},
});
