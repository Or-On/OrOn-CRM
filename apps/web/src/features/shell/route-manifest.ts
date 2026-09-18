export interface ApplicationPageRoute {
  readonly navigationParent?: string;
  readonly template: string;
}

/**
 * Page routes backed by the Next.js app directory. API routes deliberately do
 * not belong here. Keep this manifest aligned with the app-directory page
 * files so shell navigation cannot imply that a nonexistent detail page exists.
 */
export const applicationPageManifest = [
  { template: "/", navigationParent: "/" },
  { template: "/calendar", navigationParent: "/calendar" },
  { template: "/contacts", navigationParent: "/contacts" },
  { template: "/contacts/[id]", navigationParent: "/contacts" },
  { template: "/email", navigationParent: "/email" },
  { template: "/en" },
  { template: "/field-service", navigationParent: "/field-service" },
  {
    template: "/field-service/ocr",
    navigationParent: "/field-service",
  },
  {
    template: "/field-service/reports",
    navigationParent: "/field-service",
  },
  {
    template: "/field-service/cases/[id]",
    navigationParent: "/field-service",
  },
  {
    template: "/field-service/reports/[id]",
    navigationParent: "/field-service",
  },
  { template: "/finance", navigationParent: "/finance" },
  { template: "/flows", navigationParent: "/voice" },
  { template: "/he" },
  { template: "/inbox", navigationParent: "/inbox" },
  { template: "/invite" },
  { template: "/login" },
  { template: "/operations", navigationParent: "/operations" },
  { template: "/orchestration", navigationParent: "/orchestration" },
  { template: "/pipelines", navigationParent: "/pipelines" },
  { template: "/profile", navigationParent: "/profile" },
  { template: "/roles", navigationParent: "/roles" },
  { template: "/settings", navigationParent: "/settings" },
  { template: "/start" },
  { template: "/system/health", navigationParent: "/system/health" },
  // Legacy deep links keep working; the rail now highlights Tickets.
  { template: "/tasks", navigationParent: "/tickets" },
  { template: "/tickets", navigationParent: "/tickets" },
  { template: "/tickets/[id]", navigationParent: "/tickets" },
  { template: "/tenants", navigationParent: "/tenants" },
  { template: "/users", navigationParent: "/users" },
  { template: "/voice", navigationParent: "/voice" },
  { template: "/voice/calls/[id]", navigationParent: "/voice" },
  { template: "/voice/campaigns", navigationParent: "/voice" },
] as const satisfies readonly ApplicationPageRoute[];

function pathOnly(href: string): string {
  const boundary = href.search(/[?#]/u);
  const value = boundary === -1 ? href : href.slice(0, boundary);
  if (value.length > 1 && value.endsWith("/")) return value.slice(0, -1);
  return value;
}

function routeMatches(template: string, pathname: string): boolean {
  const expected = template.split("/");
  const actual = pathOnly(pathname).split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) =>
      segment.startsWith("[") && segment.endsWith("]")
        ? (actual[index]?.length ?? 0) > 0
        : segment === actual[index],
    )
  );
}

export function applicationPageForHref(
  href: string,
): ApplicationPageRoute | undefined {
  if (!href.startsWith("/") || href.startsWith("//")) return undefined;
  return applicationPageManifest.find(({ template }) =>
    routeMatches(template, href),
  );
}

export function isApplicationPageHref(href: string): boolean {
  return applicationPageForHref(href) !== undefined;
}
