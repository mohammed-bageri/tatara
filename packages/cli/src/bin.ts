#!/usr/bin/env node
import { Command, Option } from "commander";
import pc from "picocolors";
import { addAddons } from "./commands/add.ts";
import { runAppCli } from "./commands/app-cli.ts";
import { check } from "./commands/check.ts";
import { writeContracts } from "./commands/contracts.ts";
import { DbError, dbGenerate, dbMigrate, dbReset, dbSeed, dbStudio } from "./commands/db.ts";
import { dev } from "./commands/dev.ts";
import { doctor, printDoctor } from "./commands/doctor.ts";
import { EjectError, eject } from "./commands/eject.ts";
import { newApp } from "./commands/new.ts";
import { listRoutes, printRoutes } from "./commands/routes.ts";
import { sync } from "./commands/sync.ts";
import { tinker } from "./commands/tinker.ts";
import { biomeFormat, printUpgrade, upgrade } from "./commands/upgrade.ts";
import { verify } from "./commands/verify.ts";
import { OptionsError } from "./engine/resolve.ts";
import { FEATURES } from "./features/index.ts";
import { GENERATORS, GeneratorError, type GeneratorKind, generate } from "./generators/index.ts";
import { cliVersion } from "./paths.ts";
import { loadProject, NotATataraProject } from "./project/config.ts";

const program = new Command("tatara")
	.description("Create and grow opinionated Hono backends")
	.version(cliVersion());

program
	.command("new")
	.description("Create a new app")
	.argument("[dir]", "directory to create")
	.option("--orm <orm>", "drizzle | prisma | none")
	.option("--db <database>", "postgres | mysql | none")
	.option(
		"--auth <provider>",
		"better-auth | none (keycloak = better-auth with --auth-methods keycloak)",
	)
	.option("--auth-methods <list>", "email-otp,phone-otp,password,orgs (better-auth)")
	.option(
		"--addons <list>",
		Object.values(FEATURES)
			.filter((f) => f.kind === "addon")
			.map((f) => f.id)
			.join(","),
	)
	.option("--pm <pm>", "pnpm | npm | bun")
	.option("-y, --yes", "skip prompts and use flags/defaults")
	.option("--no-install", "do not install dependencies")
	.option("--no-git", "do not initialise git")
	.addOption(new Option("--framework-tests", "include tatara's own wiring tests (e2e)").hideHelp())
	.action(async (dir, flags) => {
		await newApp(dir, flags);
	});

program
	.command("sync")
	.description("Regenerate src/generated from discovered module files")
	.option("--quiet", "no output")
	.action(async (flags: { quiet?: boolean }) => {
		const { written, removed } = await sync();
		if (!flags.quiet && written.length > 0)
			console.log(pc.dim(`tatara sync: ${written.length} file(s) updated`));
		if (!flags.quiet && removed.length > 0)
			console.log(pc.dim(`tatara sync: ${removed.length} stale file(s) removed`));
	});

program
	.command("check")
	.description("Check layout rules (part of lint)")
	.option("--json", "machine-readable output")
	.action(async (flags: { json?: boolean }) => {
		const violations = await check();
		if (flags.json) console.log(JSON.stringify({ violations }, null, 2));
		else if (violations.length === 0) console.log(pc.green("tatara check: layout OK"));
		else {
			for (const v of violations)
				console.log(`${pc.red("✖")} ${v.file}:${v.line} ${pc.dim(`[${v.rule}]`)} ${v.message}`);
			console.log(pc.red(`\n${violations.length} layout violation(s)`));
		}
		if (violations.length > 0) process.exitCode = 1;
	});

program
	.command("verify")
	.description("Lint, layout, typecheck, test and build")
	.action(async () => {
		if (!(await verify())) process.exitCode = 1;
	});

program
	.command("make")
	.description(`Generate code: ${GENERATORS.join(", ")}`)
	.argument("<kind>", GENERATORS.join(" | "))
	.argument("<name>", "name, e.g. billing-account")
	.option("-m, --module <module>", "module the code belongs to")
	.option("--dry-run", "show the files without writing them")
	.option("--json", "machine-readable output")
	.action(
		async (
			kind: string,
			name: string,
			flags: { module?: string; dryRun?: boolean; json?: boolean },
		) => {
			if (!(GENERATORS as readonly string[]).includes(kind)) {
				throw new GeneratorError(
					`Unknown generator "${kind}". Use one of: ${GENERATORS.join(", ")}`,
				);
			}
			const result = await generate(loadProject(), {
				kind: kind as GeneratorKind,
				name,
				...(flags.module ? { module: flags.module } : {}),
				...(flags.dryRun ? { dryRun: true } : {}),
			});
			if (flags.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}
			const verb = result.dryRun ? "would create" : "created";
			for (const file of result.files) console.log(`${pc.green(verb)} ${file}`);
		},
	);

const db = program.command("db").description("Database tasks for the app's ORM");
db.command("generate")
	.description("Create a migration from schema changes")
	.option("-n, --name <name>", "migration name", "change")
	.action(async (flags: { name: string }) => {
		process.exitCode = await dbGenerate(loadProject(), flags.name);
	});
db.command("migrate")
	.description("Apply pending migrations")
	.action(async () => {
		process.exitCode = await dbMigrate(loadProject());
	});
db.command("seed")
	.description("Run seeds")
	.action(async () => {
		process.exitCode = await dbSeed(loadProject());
	});
db.command("reset")
	.description("Drop all tables, migrate and seed (not in production)")
	.action(async () => {
		process.exitCode = await dbReset(loadProject());
	});
db.command("studio")
	.description("Open the ORM's database studio")
	.action(async () => {
		process.exitCode = await dbStudio(loadProject());
	});

program
	.command("dev")
	.description("Start local services, migrate, seed and run every process with reload")
	.option("--down", "stop local services")
	.option("--reset", "stop local services and delete their data, then start fresh")
	.option("--prepare", "start services, migrate and seed, then exit")
	.action(async (flags: { down?: boolean; reset?: boolean; prepare?: boolean }) => {
		// exit explicitly: child processes and watchers are gone, but stdin may still be open
		process.exit(await dev(loadProject(), flags));
	});

program
	.command("run")
	.description("Run an app command (see `tatara run --list`)")
	.argument("[command]", "command name")
	.argument("[args...]", "arguments passed to the command")
	.option("--list", "list commands")
	.allowUnknownOption()
	.helpOption(false)
	.action(async (command: string | undefined, args: string[], flags: { list?: boolean }) => {
		const project = loadProject();
		const { sync: runSync } = await import("./commands/sync.ts");
		await runSync(project);
		const argv = flags.list || !command ? ["--list"] : [command, ...args];
		process.exitCode = await runAppCli(project, argv);
	});

program
	.command("tinker")
	.description("REPL with env, logger, db and module services loaded")
	.action(async () => {
		process.exitCode = await tinker(loadProject());
	});

program
	.command("routes")
	.description("List every route and what protects it")
	.option("--json", "machine-readable output")
	.action(async (flags: { json?: boolean }) => {
		const routes = await listRoutes(loadProject());
		if (flags.json) console.log(JSON.stringify(routes, null, 2));
		else printRoutes(routes);
	});

program
	.command("add <addons...>")
	.description("Add add-ons to this app: their files, packages and env (and the add-ons they need)")
	.action(async (addons: string[]) => {
		const report = await addAddons(loadProject(), addons);
		console.log(pc.green(`added ${report.added.join(", ")}`));
		for (const file of report.written) console.log(`  ${pc.green("✔")} ${file}`);
		for (const file of report.merge) console.log(`  ${pc.yellow("merge by hand")} ${file}`);
		for (const note of report.notes) console.log(pc.dim(note));
		if (!(await verify(loadProject()))) process.exitCode = 1;
	});

program
	.command("contracts")
	.description("Write each app's OpenAPI document and TypeScript types for typed clients")
	.option("--out <dir>", "folder to write them to", "contracts")
	.option("--check", "fail when the files are out of date instead of writing them")
	.action(async (flags: { out: string; check?: boolean }) => {
		const { written, stale } = await writeContracts(loadProject(), flags);
		for (const file of written) console.log(`${pc.green("✔")} ${file}`);
		if (stale.length > 0) {
			console.error(`Out of date: ${stale.join(", ")}. Run tatara contracts.`);
			process.exitCode = 1;
		}
	});

program
	.command("upgrade")
	.description("Run this CLI version's codemods on the app, then sync and verify")
	.option("--dry-run", "show what would change without writing")
	.option("--no-verify", "skip pnpm verify at the end")
	.action(async (flags: { dryRun?: boolean; verify?: boolean }) => {
		const project = loadProject();
		const from = project.config.version;
		const report = await upgrade(project, { dryRun: flags.dryRun });
		printUpgrade(report, from, cliVersion());
		if (!flags.dryRun && flags.verify !== false && !(await verify(loadProject()))) {
			process.exitCode = 1;
		}
	});

program
	.command("eject <package>")
	.description("Copy a @tatara/* package's source into src/ejected; the app owns it from then on")
	.option("--with-dependents", "also eject installed @tatara/* packages that depend on it")
	.action(async (name: string, flags: { withDependents?: boolean }) => {
		const project = loadProject();
		const report = await eject(project, name, {
			withDependents: flags.withDependents,
			formatFile: biomeFormat,
		});
		const names = report.ejected.map((n) => `@tatara/${n}`).join(", ");
		console.log(pc.green(`ejected ${names} into src/ejected (${report.copied.length} files)`));
		if (report.rewritten.length > 0)
			console.log(`  ${report.rewritten.length} files now import the ejected copy`);
		if (report.added.length > 0) console.log(`  added dependencies: ${report.added.join(", ")}`);
		console.log(
			`  run your package manager's install, then verify; tatara upgrade skips ${names} from now on`,
		);
	});

program
	.command("doctor")
	.description("Check the toolchain, services, env and layout")
	.option("--json", "machine-readable output")
	.action(async (flags: { json?: boolean }) => {
		const checks = await doctor(loadProject());
		if (flags.json) console.log(JSON.stringify(checks, null, 2));
		else printDoctor(checks);
		if (checks.some((c) => !c.ok)) process.exitCode = 1;
	});

program.parseAsync().catch((error: unknown) => {
	if (
		error instanceof OptionsError ||
		error instanceof EjectError ||
		error instanceof NotATataraProject ||
		error instanceof GeneratorError ||
		error instanceof DbError
	) {
		console.error(pc.red(error.message));
	} else {
		console.error(error);
	}
	process.exit(1);
});
