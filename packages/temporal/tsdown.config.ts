import { defineConfig } from "tsdown";
import { libraryConfig } from "../../tsdown.base.ts";

export default defineConfig(
	libraryConfig({
		index: "src/index.ts",
		worker: "src/worker.ts",
		commands: "src/commands.ts",
	}),
);
