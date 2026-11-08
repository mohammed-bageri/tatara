import { defineConfig } from "tsdown";
import { libraryConfig } from "../../tsdown.base.ts";

export default defineConfig(
	libraryConfig({
		index: "src/index.ts",
		commands: "src/commands.ts",
		postgres: "src/postgres.ts",
		mariadb: "src/mariadb.ts",
		mysql2: "src/mysql2.ts",
		prisma: "src/prisma.ts",
		"drizzle-postgres": "src/drizzle-postgres.ts",
		"drizzle-mysql": "src/drizzle-mysql.ts",
		tinker: "src/tinker.ts",
	}),
);
