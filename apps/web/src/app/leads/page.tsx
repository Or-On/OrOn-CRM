import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  countLeads,
  getTenantSettings,
  listLeadAgentFilters,
  listLeads,
  listTeamMembers,
  requireTenantFeature,
  TenantFeatureDisabledError,
  type LeadListOptions,
  type LeadSortKey,
  type LeadSourceChannel,
  type LeadStatus,
} from "@or-on/crm";

import { AccessDenied } from "../../i18n/access-denied";
import {
  ForbiddenError,
  UnauthenticatedError,
  withCurrentTenant,
} from "../../features/auth";
import { LeadsWorkspace } from "../../features/leads";

const statuses = new Set<string>([
  "new",
  "collecting",
  "ready_for_review",
  "qualified",
  "disqualified",
  "converted",
  "archived",
]);
const channels = new Set<string>(["voice", "whatsapp", "manual", "api"]);
const sorts = new Set<string>(["updated", "created", "due"]);

function single(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const first = typeof value === "string" ? value : value[0];
  return first === undefined || first === "" ? undefined : first;
}

/**
 * Rebuild the filter from the URL so a deep link, a reload and a shared link
 * all render the same page on the server. An unrecognised value is dropped
 * rather than rejected: a stale bookmark should show the default register, not
 * an error screen.
 */
function filterFromQuery(
  query: Readonly<Record<string, string | readonly string[] | undefined>>,
): LeadListOptions {
  const status = single(query.status);
  const channel = single(query.channel);
  const sort = single(query.sort);
  const search = single(query.q);
  const owner = single(query.owner);
  const agent = single(query.agent);
  const since = single(query.since);
  return {
    status:
      status === "all" || status === "open"
        ? status
        : status !== undefined && statuses.has(status)
          ? (status as LeadStatus)
          : "open",
    ...(channel !== undefined && channels.has(channel)
      ? { sourceChannel: channel as LeadSourceChannel }
      : {}),
    ...(sort !== undefined && sorts.has(sort)
      ? { sort: sort as LeadSortKey }
      : {}),
    ...(search === undefined ? {} : { query: search }),
    ...(owner === "none"
      ? { unassigned: true }
      : owner === undefined
        ? {}
        : { ownerUserId: owner }),
    ...(agent === undefined ? {} : { agentProfileVersionId: agent }),
    ...(since !== undefined && Number.isFinite(Date.parse(since))
      ? { since }
      : {}),
  };
}

export default async function LeadsPage({
  searchParams,
}: {
  readonly searchParams: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}) {
  const query = await searchParams;
  const filter = filterFromQuery(query);
  try {
    const data = await withCurrentTenant("crm:read", async (sql) => {
      await requireTenantFeature(sql, "leads");
      const [page, counts, team, agents, settings] = await Promise.all([
        listLeads(sql, { ...filter, limit: 25 }),
        // The same filter object, so the badge and the rows can never disagree.
        countLeads(sql, filter),
        listTeamMembers(sql),
        listLeadAgentFilters(sql),
        getTenantSettings(sql),
      ]);
      return { page, counts, team, agents, settings };
    });
    return (
      <main className="page page--wide">
        <LeadsWorkspace
          agents={data.agents}
          initialCounts={data.counts}
          initialPage={data.page}
          team={data.team.map((member) => ({
            userId: member.userId,
            name: member.displayName ?? member.email,
          }))}
          tenantTimeZone={data.settings.timezone}
        />
      </main>
    );
  } catch (error) {
    if (
      error instanceof ForbiddenError ||
      error instanceof TenantFeatureDisabledError
    )
      return <AccessDenied />;
    if (error instanceof UnauthenticatedError) redirect("/login");
    throw error;
  }
}

export const metadata: Metadata = {
  title: "Leads",
  description:
    "Commercial interest captured by agents across WhatsApp, voice and manual work.",
};
