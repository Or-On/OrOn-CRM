export const canonicalRoles = ["owner", "admin", "agent", "viewer"] as const;
export type Role = (typeof canonicalRoles)[number];

export const permissions = [
  "platform:read",
  "voice:read",
  "voice:operate",
  "crm:read",
  "crm:write",
  "pipelines:manage",
  "messaging:operate",
  "campaigns:manage",
  "flows:manage",
  "members:manage",
  "members:change-role",
  "tenant:manage",
] as const;
export type Permission = (typeof permissions)[number];

const rolePermissions: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  owner: new Set(permissions),
  admin: new Set([
    "platform:read",
    "voice:read",
    "voice:operate",
    "crm:read",
    "crm:write",
    "pipelines:manage",
    "messaging:operate",
    "campaigns:manage",
    "flows:manage",
    "members:manage",
    "members:change-role",
    "tenant:manage",
  ]),
  agent: new Set([
    "platform:read",
    "voice:read",
    "voice:operate",
    "crm:read",
    "crm:write",
    "pipelines:manage",
    "messaging:operate",
  ]),
  viewer: new Set(["platform:read", "voice:read", "crm:read"]),
};

export function normalizeRole(value: string): Role | undefined {
  const normalized = value === "editor" ? "admin" : value;
  return canonicalRoles.find((role) => role === normalized);
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return rolePermissions[role].has(permission);
}

/**
 * Canonical authorization decision for an authenticated platform session.
 *
 * Platform super-administrators are deliberately modeled separately from
 * tenant roles. Keeping the bypass here prevents API handlers, service grants,
 * and the public session projection from drifting into different policies.
 */
export function isAuthorized(
  principal: { readonly role: Role; readonly isSuperuser: boolean },
  permission: Permission,
): boolean {
  return principal.isSuperuser || hasPermission(principal.role, permission);
}

export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target !== "owner";
  return false;
}
