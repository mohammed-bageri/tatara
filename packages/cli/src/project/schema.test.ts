import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ProjectConfig, RegistryKind } from "./config.ts";

const schema = JSON.parse(
	readFileSync(join(import.meta.dirname, "../../../../schema/tatara.json"), "utf8"),
) as {
	properties: Record<string, unknown> & {
		registries: { items: { properties: Record<string, unknown>; additionalProperties: boolean } };
	};
	additionalProperties: boolean;
};

// Required<> makes a new ProjectConfig field a compile error here until it's listed
const every: Required<ProjectConfig> = {
	$schema: "",
	version: "0.0.0",
	name: "app",
	orm: "none",
	database: "none",
	auth: "none",
	authMethods: [],
	addons: [],
	packageManager: "pnpm",
	generated: { cli: "0.0.0", files: {} },
	ejected: {},
	paths: {},
	registries: [],
};

it("schema/tatara.json allows every tatara.json field", () => {
	expect(schema.additionalProperties).toBe(false);
	expect(Object.keys(every).filter((key) => !(key in schema.properties))).toEqual([]);
});

const registry: Required<RegistryKind> = {
	name: "subjects",
	glob: "src/modules/*/approval-subjects/*.ts",
	export: "subject",
	each: "item",
	type: { import: "#modules/approvals/subjects", name: "ApprovalSubject" },
	shape: "list",
	unique: "subjectType",
};

it("schema/tatara.json allows every registries field", () => {
	const items = schema.properties.registries.items;
	expect(items.additionalProperties).toBe(false);
	expect(Object.keys(registry).filter((key) => !(key in items.properties))).toEqual([]);
});
