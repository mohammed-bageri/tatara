import { describe, expect, it } from "vitest";
import { nonLiteralMounts, routeMountCollisions } from "./route-mounts.ts";

const route = (app: string, basePath: string) =>
	`const router = createRouter();\nexport default defineRoutes({ app: "${app}", basePath: "${basePath}", router });\n`;

describe("routeMountCollisions", () => {
	it("reports a second route file on the same app and base path", () => {
		const sources = new Map([
			["src/modules/games/routes/game.routes.ts", route("api", "/games")],
			["src/modules/games/routes/games.routes.ts", route("api", "/games")],
		]);
		expect(routeMountCollisions(sources)).toEqual([
			{
				file: "src/modules/games/routes/games.routes.ts",
				line: 2,
				rule: "duplicate-base-path",
				message:
					'api "/games" is already mounted by src/modules/games/routes/game.routes.ts; routers on one base path shadow each other, so give this one its own basePath',
			},
		]);
	});

	it("allows the same base path on different apps", () => {
		const sources = new Map([
			["src/modules/a/routes/a.routes.ts", route("api", "/games")],
			["src/modules/a/routes/a-admin.routes.ts", route("admin", "/games")],
		]);
		expect(routeMountCollisions(sources)).toEqual([]);
	});

	it("reads app and basePath in either order and ignores non-route files", () => {
		const sources = new Map([
			["src/modules/a/routes/x.routes.ts", 'defineRoutes({ basePath: "/x", router, app: "api" })'],
			[
				"src/modules/b/routes/y.routes.ts",
				'defineRoutes({\n\tapp: "api",\n\tbasePath: "/x",\n\trouter,\n})',
			],
			["src/modules/b/services/y.ts", route("api", "/x")],
		]);
		expect(routeMountCollisions(sources).map((v) => v.file)).toEqual([
			"src/modules/b/routes/y.routes.ts",
		]);
	});
});

describe("nonLiteralMounts", () => {
	const file = "src/modules/a/routes/a.routes.ts";
	const violation = (key: string, line = 1) => ({
		file,
		line,
		rule: "literal-base-path",
		message: `${key} must be a string literal so duplicate mounts are detectable`,
	});

	it("accepts literal app and basePath", () => {
		const sources = new Map([[file, route("api", "/a")]]);
		expect(nonLiteralMounts(sources)).toEqual([]);
	});

	it("reports a basePath read from a constant", () => {
		const sources = new Map([
			[file, 'const BASE = "/a";\ndefineRoutes({ app: "api", basePath: BASE, router });'],
		]);
		expect(nonLiteralMounts(sources)).toEqual([violation("basePath", 2)]);
	});

	it("reports a computed basePath and a non-literal app", () => {
		const sources = new Map([
			[file, 'defineRoutes({ app: APP, basePath: join(BASE, "x"), router });'],
			[
				"src/modules/b/routes/b.routes.ts",
				'defineRoutes({ app: "api", basePath: "/b" + x, router });',
			],
		]);
		expect(nonLiteralMounts(sources).map((v) => [v.file, v.message.split(" ")[0]])).toEqual([
			[file, "app"],
			[file, "basePath"],
			["src/modules/b/routes/b.routes.ts", "basePath"],
		]);
	});

	it("reports shorthand properties and a definition that is not an object literal", () => {
		const sources = new Map([
			[file, "defineRoutes({ app, basePath, router });"],
			["src/modules/b/routes/b.routes.ts", "export default defineRoutes(definition);"],
		]);
		expect(nonLiteralMounts(sources).map((v) => `${v.file} ${v.message.split(" ")[0]}`)).toEqual([
			`${file} app`,
			`${file} basePath`,
			"src/modules/b/routes/b.routes.ts app",
			"src/modules/b/routes/b.routes.ts basePath",
		]);
	});

	it("reads the mount's own keys, not ones nested in middleware or strings", () => {
		const sources = new Map([
			[
				file,
				'defineRoutes({\n\tmiddleware: [gate({ basePath: "/x" })],\n\tapp: "api",\n\tbasePath: "/a/{id}",\n\trouter,\n});',
			],
			[
				"src/modules/b/routes/b.routes.ts",
				'defineRoutes({ app: "api", middleware: [gate({ basePath: "/x" })], basePath: BASE, router });',
			],
		]);
		expect(nonLiteralMounts(sources)).toEqual([
			{ ...violation("basePath"), file: "src/modules/b/routes/b.routes.ts" },
		]);
	});

	it("ignores files that are not route files", () => {
		const sources = new Map([["src/modules/a/services/a.ts", "defineRoutes(definition);"]]);
		expect(nonLiteralMounts(sources)).toEqual([]);
	});
});
