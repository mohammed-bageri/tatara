export type Orm = "drizzle" | "prisma";
export type Database = "postgres" | "mysql";
export type AuthProvider = "better-auth" | "none";
export type AuthMethod = "email-otp" | "phone-otp" | "password" | "keycloak" | "orgs";
export type Addon =
	| "authz"
	| "jobs"
	| "events"
	| "cache"
	| "notifications"
	| "realtime"
	| "observability"
	| "admin"
	| "storage"
	| "email"
	| "i18n"
	| "ai";
export type PackageManager = "pnpm" | "npm" | "bun";

export interface AppOptions {
	name: string;
	orm: Orm | "none";
	database: Database | "none";
	auth: AuthProvider;
	authMethods: AuthMethod[];
	addons: Addon[];
	packageManager: PackageManager;
}

export type FeatureKind = "base" | "database" | "orm" | "auth" | "auth-method" | "addon";

export interface EnvVar {
	key: string;
	/** zod expression used in src/core/config/env.ts, e.g. `z.url()` */
	schema: string;
	/** value written to .env.example */
	example: string;
	/** value written to .env; defaults to example. `secret` generates a random value. */
	dev?: string;
	/** value written to .env.test; defaults to dev */
	test?: string;
	secret?: boolean;
	comment?: string;
	/** only written to .env files (used by compose), not validated by the app */
	composeOnly?: boolean;
}

export interface ComposeService {
	[key: string]: unknown;
}

export interface SlotContribution {
	file: string;
	slot: string;
	content: string;
	/** only applied when every listed feature is selected */
	when?: string[];
	/** only applied when none of the listed features is selected */
	unless?: string[];
	order?: number;
}

export interface Entrypoint {
	/** apps/<name>/<file> */
	name: string;
	file: string;
	/** command used by `tatara dev` and the Dockerfile docs */
	description: string;
}

/** Extra packages/env applied only when `when` features are selected (and `unless` are not). */
export interface FeatureVariant {
	when?: string[];
	unless?: string[];
	dependencies?: string[];
	devDependencies?: string[];
	scripts?: Record<string, string>;
	allowBuilds?: string[];
	env?: EnvVar[];
}

export interface Feature {
	id: string;
	kind: FeatureKind;
	label: string;
	dependencies?: string[];
	devDependencies?: string[];
	scripts?: Record<string, string>;
	/** packages whose install scripts must be allowed (pnpm allowBuilds) */
	allowBuilds?: string[];
	env?: EnvVar[];
	compose?: Record<string, ComposeService>;
	composeVolumes?: string[];
	slots?: SlotContribution[];
	entrypoints?: Entrypoint[];
	/** markdown appended to AGENTS.md */
	agents?: string;
	variants?: FeatureVariant[];
	/** template directory under templates/features; defaults to id */
	templateDir?: string;
}
