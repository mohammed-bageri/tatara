/**
 * Scaffolds packages/<name>: a @tatara/* library that follows docs/packages.md.
 * Usage: pnpm new-package <name> [--peer <package>]...
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = process.env.TATARA_PACKAGES_DIR ?? join(ROOT, "packages");
const VERSIONS_FILE =
	process.env.TATARA_VERSIONS_FILE ?? join(ROOT, "packages", "cli", "templates", "versions.json");

const [name, ...rest] = process.argv.slice(2);
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
	console.error(
		"usage: pnpm new-package <name> [--peer <package>]...  (name: lowercase, digits, dashes)",
	);
	process.exit(1);
}
const peers: string[] = [];
for (let i = 0; i < rest.length; i++) {
	if (rest[i] === "--peer" && rest[i + 1]) peers.push(rest[++i] as string);
}

const dir = join(PACKAGES_DIR, name);
if (existsSync(dir)) {
	console.error(`${dir} already exists`);
	process.exit(1);
}
const versions = JSON.parse(readFileSync(VERSIONS_FILE, "utf8")) as Record<string, string>;
const peerDependencies = Object.fromEntries(
	peers.map((peer) => {
		const version = versions[peer];
		if (!version) throw new Error(`templates/versions.json has no version for "${peer}"`);
		return [peer, `^${version}`];
	}),
);

const pkg = {
	name: `@tatara/${name}`,
	version: "0.0.0",
	description: "",
	type: "module",
	license: "MIT",
	sideEffects: false,
	exports: { ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" } },
	files: ["dist", "src", "!src/**/*.test.ts"],
	engines: { node: ">=24" },
	scripts: { build: "tsdown", typecheck: "tsc --noEmit" },
	...(peers.length ? { peerDependencies, devDependencies: peerDependencies } : {}),
	publishConfig: { access: "public" },
	repository: {
		type: "git",
		url: "git+https://github.com/mohammed-bageri/tatara.git",
		directory: `packages/${name}`,
	},
	homepage: "https://github.com/mohammed-bageri/tatara#readme",
	bugs: { url: "https://github.com/mohammed-bageri/tatara/issues" },
};

const files: Record<string, string> = {
	"package.json": `${JSON.stringify(pkg, null, "\t")}\n`,
	"tsconfig.json": `${JSON.stringify(
		{ extends: "../../tsconfig.base.json", compilerOptions: { noEmit: true }, include: ["src"] },
		null,
		"\t",
	)}\n`,
	"tsdown.config.ts": `import { defineConfig } from "tsdown";\nimport { libraryConfig } from "../../tsdown.base.ts";\n\nexport default defineConfig(libraryConfig({ index: "src/index.ts" }));\n`,
	"src/index.ts": `/** @tatara/${name} */\nexport {};\n`,
	"src/index.test.ts": `import { expect, it } from "vitest";\nimport * as api from "./index.ts";\n\nit("loads without side effects", () => {\n\texpect(api).toBeTypeOf("object");\n});\n`,
	"README.md": `# @tatara/${name}\n\nPart of [tatara](https://github.com/mohammed-bageri/tatara).\n`,
};
for (const [file, text] of Object.entries(files)) {
	mkdirSync(join(dir, file, ".."), { recursive: true });
	writeFileSync(join(dir, file), text);
}
console.log(`created packages/${name}`);
