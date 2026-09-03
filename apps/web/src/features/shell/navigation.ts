export const navigation = [
  { href: "/", label: "Overview", group: "Workspace", icon: "overview" },
  { href: "/inbox", label: "Inbox", group: "Workspace", icon: "inbox" },
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
    href: "/operations",
    label: "Messaging campaigns",
    group: "Operations",
    icon: "campaigns",
  },
  {
    href: "/voice",
    label: "Voice & calls",
    group: "Operations",
    icon: "voice",
  },
  {
    href: "/voice/campaigns",
    label: "Voice campaigns",
    group: "Operations",
    icon: "campaigns",
  },
  {
    href: "/orchestration",
    label: "Agents & flows",
    group: "Operations",
    icon: "agents",
  },
  {
    href: "/flows",
    label: "Voice flow library",
    group: "Operations",
    icon: "flows",
  },
  {
    href: "/settings",
    label: "Settings",
    group: "Workspace tools",
    icon: "settings",
  },
  {
    href: "/system/health",
    label: "System health",
    group: "Workspace tools",
    icon: "health",
  },
] as const;

/** Longest matching destination avoids two active links on nested voice pages. */
export function activeDestination(pathname: string): string | undefined {
  return navigation
    .filter(
      ({ href }) =>
        pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)),
    )
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
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
