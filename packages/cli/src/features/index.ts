import {
	admin,
	authz,
	cache,
	email,
	events,
	i18n,
	jobs,
	notifications,
	observability,
	realtime,
	storage,
} from "./addons.ts";
import {
	auth,
	authEmailOtp,
	authKeycloak,
	authOrgs,
	authPassword,
	authPhoneOtp,
	betterAuth,
} from "./auth.ts";
import { base, bun, npm, pnpm } from "./base.ts";
import { db, drizzle, mysql, postgres, prisma } from "./database.ts";
import type { Feature } from "./types.ts";

export const FEATURES: Record<string, Feature> = Object.fromEntries(
	[
		base,
		pnpm,
		npm,
		bun,
		db,
		postgres,
		mysql,
		drizzle,
		prisma,
		betterAuth,
		authEmailOtp,
		authPhoneOtp,
		authPassword,
		authOrgs,
		authKeycloak,
		auth,
		authz,
		jobs,
		events,
		cache,
		notifications,
		realtime,
		admin,
		storage,
		email,
		i18n,
		// last: its start scripts replace the others'
		observability,
	].map((f) => [f.id, f]),
);
