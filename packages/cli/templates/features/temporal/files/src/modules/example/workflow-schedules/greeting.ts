import { defineWorkflowSchedule } from "@tatara/temporal";

export default defineWorkflowSchedule({
	id: "example.daily-greeting",
	workflow: "exampleGreeting",
	cron: "0 9 * * *",
	timezone: "UTC",
	args: ["world"],
});
