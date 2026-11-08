import { defineConfig } from "tsdown";
import { libraryConfig } from "../../tsdown.base.ts";

export default defineConfig(
	libraryConfig({
		index: "src/index.ts",
		commands: "src/commands.ts",
		s3: "src/s3.ts",
		gcs: "src/gcs.ts",
	}),
);
