/** Scope hierarchy: a grant at a higher rank satisfies a check at a lower one (org > team > own). */
export const SCOPES = ["own", "team", "org"] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_RANK: Record<Scope, number> = { own: 1, team: 2, org: 3 };

export const OVERLAY_EFFECTS = ["grant", "deny"] as const;
export type OverlayEffect = (typeof OVERLAY_EFFECTS)[number];

export const AUDIT_CHANGE_TYPES = [
	"role_created",
	"role_updated",
	"role_duplicated",
	"role_deleted",
	"member_role_assigned",
	"member_role_revoked",
	"overlay_granted",
	"overlay_revoked",
	"member_removed",
] as const;
export type AuditChangeType = (typeof AUDIT_CHANGE_TYPES)[number];

/** Audit actor for changes made by the system rather than a user (e.g. org membership hooks). */
export const SYSTEM_ACTOR = "system";

/** Org used when the principal has none (single-tenant apps, users without an active org). */
export const DEFAULT_ORG_ID = "default";

/** Org id stored on system (built-in) roles; they apply to every org. */
export const SYSTEM_ORG_ID = "";
