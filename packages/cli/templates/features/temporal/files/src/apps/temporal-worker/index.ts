import { handleSignals } from "@tatara/core";
import { startTemporalWorker, workflowsPath } from "@tatara/temporal/worker";
import { logger } from "#core/logging/logger";
import { temporal } from "#core/temporal/index";
import { activities } from "#generated/activities";

await startTemporalWorker({
	temporal,
	activities,
	logger,
	workflowsPath: workflowsPath(import.meta.url, {
		source: "../../generated/workflows.ts",
		built: "../../workflows.mjs",
	}),
});
handleSignals(logger);
