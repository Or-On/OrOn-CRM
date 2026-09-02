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

export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target === "agent" || target === "viewer";
  return false;
}
