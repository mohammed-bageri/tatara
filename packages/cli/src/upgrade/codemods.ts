import { addonPackages } from "./codemods/addon-packages.ts";
import { appOwnedAuth } from "./codemods/app-owned-auth.ts";
import { authPackage } from "./codemods/auth-package.ts";
import { authzPackage } from "./codemods/authz-package.ts";
import { authzRoles } from "./codemods/authz-roles.ts";
import { authzStores } from "./codemods/authz-stores.ts";
import { corePackage } from "./codemods/core-package.ts";
import { dbTesting } from "./codemods/db-testing.ts";
import { deployLedger } from "./codemods/deploy-ledger.ts";
import { emailV2 } from "./codemods/email-v2.ts";
import { errorOptions } from "./codemods/error-options.ts";
import { frameworkTests } from "./codemods/framework-tests.ts";
import { httpLimits } from "./codemods/http-limits.ts";
import { httpPackage } from "./codemods/http-package.ts";
import { jobsDrivers } from "./codemods/jobs-drivers.ts";
import { migrationStatus } from "./codemods/migration-status.ts";
import { notifierRoles } from "./codemods/notifier-roles.ts";
import { packageCommands } from "./codemods/package-commands.ts";
import { tablesInModules } from "./codemods/tables-in-modules.ts";
import type { UpgradeContext } from "./context.ts";

/**
 * A codemod must be idempotent: if a later codemod or `sync` fails, the app keeps its old version
 * and the next `tatara upgrade` runs every due codemod again, including ones that already ran.
 */
export interface Codemod {
	/** CLI version that introduces it; runs when an app upgrades across this version */
	version: string;
	id: string;
	description: string;
	run(ctx: UpgradeContext): Promise<void>;
}

/** Every codemod tatara ships, oldest first. Each step that moves code into a package adds one. */
export const CODEMODS: readonly Codemod[] = [
	corePackage,
	httpPackage,
	dbTesting,
	authPackage,
	authzPackage,
	addonPackages,
	frameworkTests,
	authzStores,
	packageCommands,
	appOwnedAuth,
	httpLimits,
	jobsDrivers,
	emailV2,
	deployLedger,
	authzRoles,
	notifierRoles,
	tablesInModules,
	errorOptions,
	migrationStatus,
];
