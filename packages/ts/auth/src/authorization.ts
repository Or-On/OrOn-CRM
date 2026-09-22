export const canonicalRoles = [
  "owner",
  "admin",
  "agent",
  "technician",
  "viewer",
] as const;
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
  "field-service:read",
  "field-service:operate",
  "field-service:manage",
  "customer-sensitive:read",
  "customer-sensitive:write",
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
    "field-service:read",
    "field-service:operate",
    "field-service:manage",
    "customer-sensitive:read",
    "customer-sensitive:write",
  ]),
  agent: new Set([
    "platform:read",
    "voice:read",
    "voice:operate",
    "crm:read",
    "crm:write",
    "pipelines:manage",
    "messaging:operate",
    "field-service:read",
    "field-service:operate",
  ]),
  technician: new Set([
    "platform:read",
    "field-service:read",
    "field-service:operate",
  ]),
  viewer: new Set([
    "platform:read",
    "voice:read",
    "crm:read",
    "field-service:read",
  ]),
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

/**
 * The product surface a session works in. A technician works inside the
 * dedicated Field Service application; every other tenant role, and every
 * platform super-administrator, works in the full workspace.
 */
export const applicationScopes = ["workspace", "field-service"] as const;
export type ApplicationScope = (typeof applicationScopes)[number];

const scopedPermissions: Readonly<
  Record<ApplicationScope, ReadonlySet<Permission> | undefined>
> = {
  workspace: undefined,
  "field-service": new Set([
    "field-service:read",
    "field-service:operate",
    "field-service:manage",
  ]),
};

/** Where a session lands after sign-in and when it leaves its application. */
export const applicationHome: Readonly<Record<ApplicationScope, string>> = {
  workspace: "/",
  "field-service": "/field-service",
};

const scopedRoutes: Readonly<
  Record<ApplicationScope, readonly string[] | undefined>
> = {
  workspace: undefined,
  "field-service": ["/field-service"],
};

/** Sign-in, invitation and locale entry routes serve every application. */
const entryRoutes = ["/login", "/invite", "/en", "/he"];

export function applicationScope(principal: {
  readonly role: Role;
  readonly isSuperuser: boolean;
}): ApplicationScope {
  return !principal.isSuperuser && principal.role === "technician"
    ? "field-service"
    : "workspace";
}

export function isPermissionInApplicationScope(
  scope: ApplicationScope,
  permission: Permission,
): boolean {
  return scopedPermissions[scope]?.has(permission) ?? true;
}

/**
 * Authorization for a product request: the role must grant the permission and
 * the permission must belong to the session's application. A technician keeps
 * `platform:read` for the application shell, but no workspace page or API
 * (profile, settings, health, CRM modules) accepts it from a technician.
 */
export function isAuthorizedInApplication(
  principal: { readonly role: Role; readonly isSuperuser: boolean },
  permission: Permission,
): boolean {
  return (
    isAuthorized(principal, permission) &&
    isPermissionInApplicationScope(applicationScope(principal), permission)
  );
}

/** Page-route projection of the same rule; API routes use permissions. */
export function isPathInApplicationScope(
  scope: ApplicationScope,
  pathname: string,
): boolean {
  const routes = scopedRoutes[scope];
  if (routes === undefined) return true;
  const path = pathname.split(/[?#]/u)[0] ?? pathname;
  return [...routes, ...entryRoutes].some(
    (route) => path === route || path.startsWith(`${route}/`),
  );
}

export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target !== "owner";
  return false;
}
