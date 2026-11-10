/**
 * Built-in roles. Add a key here, then grant it permissions in module permission files. A role is
 * held only by those it's assigned to, unless `heldBy` says every org member or an identity role.
 */
export const SYSTEM_ROLES = [
	// tatara:slot admin
	{ key: "member", name: "Member", description: "Every member of the org.", heldBy: "members" },
	// tatara:slot roles
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLES)[number]["key"];
