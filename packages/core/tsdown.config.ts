import { defineConfig } from "tsdown";
import { libraryConfig } from "../../tsdown.base.ts";

export default defineConfig(
	libraryConfig({
		index: "src/index.ts",
		html: "src/html.ts",
		time: "src/time.ts",
		csv: "src/csv.ts",
	}),
);
