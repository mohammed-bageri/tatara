import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { x } from "tinyexec";
import { devEnvFromExample, renderApp, writeFiles } from "../engine/generate.ts";
import { OptionsError, validateOptions } from "../engine/resolve.ts";
import type {
	Addon,
	AppOptions,
	AuthMethod,
	AuthProvider,
	Database,
	Orm,
	PackageManager,
} from "../features/types.ts";
import { cliVersion } from "../paths.ts";
import { pmCommands } from "../pm.ts";
import { loadProject, type ProjectConfig } from "../project/config.ts";
import { hashTrackedFiles } from "../project/hashes.ts";
import { afterCreate } from "./post-create.ts";
import { sync } from "./sync.ts";

export interface NewFlags {
	orm?: string;
	db?: string;
	auth?: string;
	authMethods?: string;
	addons?: string;
	pm?: string;
	yes?: boolean;
	install?: boolean;
	git?: boolean;
	/** tatara's own e2e: also write its framework tests into the app */
	frameworkTests?: boolean;
}

const ORMS = ["drizzle", "prisma", "none"] as const;
const DATABASES = ["postgres", "mysql", "none"] as const;
const AUTHS = ["better-auth", "none"] as const;
const METHODS = ["email-otp", "phone-otp", "password", "keycloak", "orgs"] as const;

/** `--auth keycloak` (before 0.1.2) is better-auth with the keycloak method. */
function normalizeAuthFlags(flags: NewFlags): NewFlags {
	if (flags.auth !== "keycloak") return flags;
	const methods = new Set((flags.authMethods ?? "").split(",").filter(Boolean));
	methods.add("keycloak");
	return { ...flags, auth: "better-auth", authMethods: [...methods].join(",") };
}
const ADDONS = [
	"authz",
	"jobs",
	"temporal",
	"events",
	"cache",
	"notifications",
	"realtime",
	"observability",
	"admin",
	"storage",
	"email",
	"i18n",
	"ai",
] as const;
const PMS = ["pnpm", "npm", "bun"] as const;

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
	if (!(allowed as readonly string[]).includes(value)) {
		throw new OptionsError(`--${flag} must be one of: ${allowed.join(", ")} (got "${value}")`);
	}
	return value as Exclude<T, symbol>;
}

function listOf<T extends string>(
	value: string | undefined,
	allowed: readonly T[],
	flag: string,
): T[] {
	if (!value || value === "none") return [];
	return value
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean)
		.map((v) => oneOf(v, allowed, flag));
}

export function detectPackageManager(): PackageManager {
	const agent = process.env.npm_config_user_agent ?? "";
	if (agent.startsWith("pnpm")) return "pnpm";
	if (agent.startsWith("bun")) return "bun";
	if (agent.startsWith("npm")) return "npm";
	return "pnpm";
}

function answer<T>(value: T): Exclude<T, symbol> {
	if (p.isCancel(value)) {
		p.cancel("Cancelled.");
		process.exit(1);
	}
	return value as Exclude<T, symbol>;
}

async function prompt(name: string, flags: NewFlags): Promise<AppOptions> {
	const orm: Orm | "none" = flags.orm
		? oneOf(flags.orm, ORMS, "orm")
		: answer(
				await p.select<Orm | "none">({
					message: "ORM",
					options: [
						{ value: "drizzle", label: "Drizzle" },
						{ value: "prisma", label: "Prisma" },
						{ value: "none", label: "No database" },
					],
				}),
			);
	let database: Database | "none" = "none";
	if (orm !== "none") {
		database = flags.db
			? oneOf(flags.db, DATABASES, "db")
			: answer(
					await p.select<Database>({
						message: "Database",
						options: [
							{ value: "postgres", label: "PostgreSQL" },
							{ value: "mysql", label: "MySQL" },
						],
					}),
				);
	}
	let auth: AuthProvider = "none";
	if (database !== "none") {
		auth = flags.auth
			? oneOf(flags.auth, AUTHS, "auth")
			: answer(
					await p.select<AuthProvider>({
						message: "Auth",
						options: [
							{ value: "better-auth", label: "better-auth", hint: "sign-in handled by the API" },
							{ value: "none", label: "None" },
						],
					}),
				);
	}
	let authMethods: AuthMethod[] = [];
	if (auth === "better-auth") {
		authMethods = flags.authMethods
			? listOf(flags.authMethods, METHODS, "auth-methods")
			: answer(
					await p.multiselect<AuthMethod>({
						message: "Sign-in methods",
						initialValues: ["email-otp"],
						options: [
							{ value: "email-otp", label: "Email OTP" },
							{ value: "phone-otp", label: "Phone OTP" },
							{ value: "password", label: "Email + password" },
							{
								value: "keycloak",
								label: "Keycloak tokens",
								hint: "API accepts Keycloak access tokens",
							},
							{
								value: "orgs",
								label: "Organizations + roles",
								hint: "organization and admin plugins",
							},
						],
						required: true,
					}),
				);
	}
	const labels: Record<Addon, string> = {
		authz: "Permission system",
		jobs: "Jobs + cron (BullMQ)",
		temporal: "Durable workflows (Temporal)",
		events: "Domain events (transactional outbox, Postgres + Drizzle)",
		cache: "Cache (Redis, Postgres or memory)",
		notifications: "Notifications (in-app, email, SMS, push)",
		realtime: "Realtime (websockets)",
		observability: "Observability (OpenTelemetry)",
		admin: "Admin API app",
		storage: "File storage",
		email: "Email",
		i18n: "i18n",
		ai: "AI (Gemini / OpenAI)",
	};
	const addons: Addon[] =
		flags.addons !== undefined
			? listOf(flags.addons, ADDONS, "addons")
			: answer(
					await p.multiselect<Addon>({
						message: "Add-ons",
						required: false,
						options: ADDONS.filter(
							(a) =>
								!((a === "authz" || a === "admin") && auth === "none") &&
								!(a === "events" && (orm !== "drizzle" || database !== "postgres")),
						).map((value) => ({ value, label: labels[value] })),
					}),
				);
	const packageManager: PackageManager = flags.pm
		? oneOf(flags.pm, PMS, "pm")
		: answer(
				await p.select<PackageManager>({
					message: "Package manager",
					initialValue: detectPackageManager(),
					options: PMS.map((value) => ({ value, label: value })),
				}),
			);
	return { name, orm, database, auth, authMethods, addons, packageManager };
}

function fromFlags(name: string, flags: NewFlags): AppOptions {
	const orm = oneOf(flags.orm ?? "drizzle", ORMS, "orm");
	const database = oneOf(flags.db ?? (orm === "none" ? "none" : "postgres"), DATABASES, "db");
	const auth = oneOf(flags.auth ?? (database === "none" ? "none" : "better-auth"), AUTHS, "auth");
	const authMethods = listOf(
		flags.authMethods ?? (auth === "better-auth" ? "email-otp" : undefined),
		METHODS,
		"auth-methods",
	);
	return {
		name,
		orm,
		database,
		auth,
		authMethods,
		addons: listOf(flags.addons, ADDONS, "addons"),
		packageManager: oneOf(flags.pm ?? detectPackageManager(), PMS, "pm"),
	};
}

async function pmVersion(pm: PackageManager): Promise<string | undefined> {
	const result = await x(pm, ["--version"], { throwOnError: false });
	return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function run(cmd: string, args: string[], cwd: string, label: string) {
	const tty = Boolean(process.stdout.isTTY);
	const spinner = tty ? p.spinner() : undefined;
	if (spinner) spinner.start(label);
	else console.log(`• ${label}`);
	const result = await x(cmd, args, { nodeOptions: { cwd }, throwOnError: false });
	if (result.exitCode !== 0) {
		spinner?.stop(pc.red(`${label} failed`));
		throw new Error(`${cmd} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
	}
	spinner?.stop(label);
}

export async function newApp(dir: string | undefined, rawFlags: NewFlags): Promise<string> {
	const flags = normalizeAuthFlags(rawFlags);
	const interactive = !flags.yes && process.stdout.isTTY;
	if (interactive) p.intro(pc.bold("tatara"));
	let target = dir;
	if (!target) {
		if (!interactive) throw new OptionsError("Pass the app directory, e.g. `tatara new my-app`.");
		target = answer(
			await p.text({ message: "App directory", placeholder: "my-app", defaultValue: "my-app" }),
		);
	}
	const root = resolve(target);
	if (existsSync(root) && readdirSync(root).length > 0) {
		throw new OptionsError(`${root} already exists and is not empty.`);
	}
	const name = root.split(/[\\/]/).at(-1) ?? "app";
	const options = validateOptions(interactive ? await prompt(name, flags) : fromFlags(name, flags));
	const pm = pmCommands(options.packageManager);

	const files = await renderApp(options, {
		pmVersion: await pmVersion(options.packageManager),
		frameworkTests: flags.frameworkTests,
	});
	await writeFiles(root, files, { env: devEnvFromExample(options) });
	const project = loadProject(root);
	await afterCreate(project, "files");

	if (flags.install !== false) {
		const [cmd, ...args] = pm.install;
		await run(cmd ?? "npm", args, root, `Installing dependencies with ${options.packageManager}`);
		await sync(project);
		await afterCreate(project, "installed");
		const [exec, ...execArgs] = pm.exec.split(" ");
		const format = await x(exec ?? "npx", [...execArgs, "biome", "check", "--write", "."], {
			nodeOptions: { cwd: root },
			throwOnError: false,
		});
		if (format.exitCode !== 0) {
			console.warn(
				pc.yellow(
					`Formatting reported problems (please report this as a tatara bug):\n${format.stdout}`,
				),
			);
		}
	}

	// last, after formatting: these hashes are what `tatara upgrade` compares the app against
	await recordGenerated(root);
	if (flags.install !== false) {
		// tatara.json is not tracked, so formatting it again does not change the recorded hashes
		const [exec, ...execArgs] = pm.exec.split(" ");
		await x(exec ?? "npx", [...execArgs, "biome", "check", "--write", "tatara.json"], {
			nodeOptions: { cwd: root },
			throwOnError: false,
		});
	}

	if (flags.git !== false) {
		const git = await x("git", ["init", "-q", "-b", "main"], {
			nodeOptions: { cwd: root },
			throwOnError: false,
		});
		if (git.exitCode === 0) {
			await x("git", ["add", "-A"], { nodeOptions: { cwd: root }, throwOnError: false });
			await x("git", ["commit", "-q", "-m", "Initial commit from tatara"], {
				nodeOptions: { cwd: root },
				throwOnError: false,
			});
		}
	}

	const next = [
		`cd ${target}`,
		...(flags.install === false ? [pm.install.join(" ")] : []),
		`${pm.run} dev`,
	];
	if (interactive) p.outro(`Done. Next:\n\n  ${next.join("\n  ")}`);
	else console.log(`Created ${root}\nNext:\n  ${next.join("\n  ")}`);
	return root;
}

async function recordGenerated(root: string): Promise<void> {
	const path = join(root, "tatara.json");
	const config = JSON.parse(await readFile(path, "utf8")) as ProjectConfig;
	config.generated = { cli: cliVersion(), files: await hashTrackedFiles(root) };
	await writeFile(path, `${JSON.stringify(config, null, "\t")}\n`);
}
