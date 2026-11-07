import { type CommandDefinition, defineCommand } from "@tatara/core";
import { defineSeed, type SeedDefinition } from "@tatara/db";
import { z } from "zod";
import type { Authz } from "./authz.ts";
import { DEFAULT_ORG_ID, SYSTEM_ORG_ID } from "./constants.ts";

// biome-ignore lint/suspicious/noExplicitAny: any app's permission keys; these commands use none
type AnyAuthz = Authz<any>;

/** authz:grant-role and authz:sync-permissions; wired into the app by `tatara sync`. */
export function authzCommands({ authz }: { authz: AnyAuthz }): CommandDefinition[] {
	return [
		defineCommand({
			name: "authz:grant-role",
			description: "Assign a role (built-in key or custom role key) to a user in an org",
			args: z.object({
				user: z.string().min(1),
				role: z.string().min(1),
				org: z.string().default(DEFAULT_ORG_ID),
			}),
			async run({ user, role, org }, { logger }) {
				const found =
					(await authz.store.findRoleByKey(org, role)) ??
					(await authz.store.findRoleByKey(SYSTEM_ORG_ID, role));
				if (!found)
					throw new Error(
						`No role "${role}" (run authz:sync-permissions first for built-in roles)`,
					);
				const added = await authz.assignRole(null, org, user, found.id);
				logger.info({ user, role, org, added }, added ? "role assigned" : "role already assigned");
			},
		}),
		defineCommand({
			name: "authz:sync-permissions",
			description:
				"Create/update built-in roles so their grants match the code (run on every deploy)",
			phase: "deploy",
			order: 10,
			async run(_args, { logger }) {
				const result = await authz.syncSystemRoles();
				logger.info(result, "built-in roles in sync");
				if (result.kept.length)
					logger.warn(
						{ kept: result.kept },
						"built-in roles no longer in the code are still assigned: reassign their members, then sync again",
					);
			},
		}),
	] as CommandDefinition[];
}

/** Keeps built-in roles in sync on every `db:seed` (and so on every `dev`). */
export function authzSeeds({ authz }: { authz: AnyAuthz }): SeedDefinition[] {
	return [
		defineSeed({
			name: "authz:system-roles",
			order: -10,
			async run({ logger }) {
				logger.info(await authz.syncSystemRoles(), "built-in roles in sync");
			},
		}),
	];
}
