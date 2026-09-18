import type { Permission } from "@or-on/auth";

import { applicationPageForHref } from "./route-manifest";

export type NavigationGroup = "Workspace" | "Operations" | "Platform";

/** Mirrors read guards; visibility never replaces server authorization. */
export function destinationPermission(href: string): Permission {
  if (href === "/voice" || href === "/flows" || href.startsWith("/voice/"))
    return "voice:read";
  if (href === "/finance") return "tenant:manage";
  if (href === "/field-service" || href.startsWith("/field-service/"))
    return "field-service:read";
  if (href === "/users" || href === "/roles") return "members:manage";
  if (
    href === "/profile" ||
    href === "/email" ||
    href === "/tenants" ||
    href === "/settings" ||
    href === "/system/health"
  )
    return "platform:read";
  return "crm:read";
}

export type NavigationIcon =
  | "overview"
  | "inbox"
  | "email"
  | "calendar"
  | "tickets"
  | "tasks"
  | "contacts"
  | "pipeline"
  | "campaigns"
  | "voice"
  | "agents"
  | "finance"
  | "profile"
  | "users"
  | "roles"
  | "settings"
  | "health"
  | "tenants"
  | "fieldService";

export interface NavigationDestination {
  readonly group: NavigationGroup;
  readonly href: string;
  readonly icon: NavigationIcon;
  readonly label: string;
}

export const navigation = [
  { href: "/", label: "Overview", group: "Workspace", icon: "overview" },
  { href: "/inbox", label: "Inbox", group: "Workspace", icon: "inbox" },
  { href: "/email", label: "Email", group: "Workspace", icon: "email" },
  {
    href: "/calendar",
    label: "Calendar",
    group: "Workspace",
    icon: "calendar",
  },
  // Tickets is the customer-facing issue register and takes the primary slot.
  // Tasks keeps its route, records, permissions and deep links, and becomes a
  // contextual destination beneath it: existing escalations still create those
  // internal work items and still link straight to them.
  { href: "/tickets", label: "Tickets", group: "Workspace", icon: "tickets" },
  {
    href: "/contacts",
    label: "Contacts",
    group: "Workspace",
    icon: "contacts",
  },
  {
    href: "/pipelines",
    label: "Pipeline",
    group: "Workspace",
    icon: "pipeline",
  },
  {
    href: "/field-service",
    label: "Field service",
    group: "Operations",
    icon: "fieldService",
  },
  {
    href: "/operations",
    label: "Messaging",
    group: "Operations",
    icon: "campaigns",
  },
  {
    href: "/voice",
    label: "Voice",
    group: "Operations",
    icon: "voice",
  },
  {
    href: "/orchestration",
    label: "Agents & Flows",
    group: "Operations",
    icon: "agents",
  },
  {
    href: "/finance",
    label: "Finance",
    group: "Operations",
    icon: "finance",
  },
  {
    href: "/profile",
    label: "Profile",
    group: "Platform",
    icon: "profile",
  },
  {
    href: "/users",
    label: "Users",
    group: "Platform",
    icon: "users",
  },
  {
    href: "/roles",
    label: "Roles",
    group: "Platform",
    icon: "roles",
  },
  {
    href: "/tenants",
    label: "Tenants",
    group: "Platform",
    icon: "tenants",
  },
  {
    href: "/system/health",
    label: "System health",
    group: "Platform",
    icon: "health",
  },
  {
    href: "/settings",
    label: "Settings",
    group: "Platform",
    icon: "settings",
  },
] as const satisfies readonly NavigationDestination[];

export const contextualDestinations = [
  {
    href: "/tasks",
    label: "Internal tasks",
    group: "Workspace",
    icon: "tasks",
    parentHref: "/tickets",
    translationKey: "tasks",
  },
  {
    href: "/voice/campaigns",
    label: "Voice campaigns",
    group: "Operations",
    icon: "campaigns",
    parentHref: "/voice",
    translationKey: "voiceCampaigns",
  },
  {
    href: "/flows",
    label: "Voice flow library",
    group: "Operations",
    icon: "voice",
    parentHref: "/voice",
    translationKey: "flows",
  },
] as const;

/** Nested and contextual routes illuminate one stable first-level destination. */
export function activeDestination(pathname: string): string | undefined {
  const matched = applicationPageForHref(pathname);
  if (matched === undefined) return undefined;
  return matched.navigationParent;
}

export function findDestinations(
  query: string,
  searchable: (item: (typeof navigation)[number]) => string = (item) =>
    `${item.label} ${item.group}`,
) {
  const term = query.trim().toLocaleLowerCase("en");
  return navigation.filter((item) =>
    searchable(item).toLocaleLowerCase("en").includes(term),
  );
}
