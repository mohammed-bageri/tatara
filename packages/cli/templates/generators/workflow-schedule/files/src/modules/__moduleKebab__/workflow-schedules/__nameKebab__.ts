import { defineWorkflowSchedule } from "@tatara/temporal";

export default defineWorkflowSchedule({
	id: "__moduleKebab__.__nameKebab__",
	// the exported name of the workflow function it starts
	workflow: "__moduleCamel____namePascal__",
	// every day at 02:00
	cron: "0 2 * * *",
	timezone: "UTC",
});
