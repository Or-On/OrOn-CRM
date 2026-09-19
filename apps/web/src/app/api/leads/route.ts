import { NextResponse } from "next/server";

import {
  countLeads,
  leadSortKeys,
  leadSourceChannels,
  leadStatuses,
  listLeads,
  type LeadListOptions,
  type LeadSortKey,
  type LeadSourceChannel,
  type LeadStatus,
} from "@or-on/crm";

import { withCurrentTenant } from "../../../features/auth";
import { crmErrorResponse } from "../../../features/crm-route";

const statuses = new Set<string>(leadStatuses);
const channels = new Set<string>(leadSourceChannels);
const sorts = new Set<string>(leadSortKeys);

/** `open` is the working queue; `all` is the archive. Neither is a lead status. */
function listStatus(
  value: string | null,
): LeadStatus | "all" | "open" | undefined {
  if (value === null) return undefined;
  if (value === "all" || value === "open") return value;
  if (!statuses.has(value)) throw new TypeError("invalid lead status");
  return value as LeadStatus;
}

function sourceChannel(value: string | null): LeadSourceChannel | undefined {
  if (value === null) return undefined;
  if (!channels.has(value)) throw new TypeError("invalid lead channel");
  return value as LeadSourceChannel;
}

function sortKey(value: string | null): LeadSortKey | undefined {
  if (value === null) return undefined;
  if (!sorts.has(value)) throw new TypeError("invalid lead sort");
  return value as LeadSortKey;
}

function listLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,3}$/u.test(value)) throw new TypeError("invalid lead page size");
  const parsed = Number(value);
  if (parsed < 1 || parsed > 100)
    throw new TypeError("lead page size must be 1 to 100");
  return parsed;
}

function instant(value: string | null, name: string): string | undefined {
  if (value === null) return undefined;
  if (!Number.isFinite(Date.parse(value)))
    throw new TypeError(`invalid lead ${name}`);
  return value;
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const status = listStatus(parameters.get("status"));
    const channel = sourceChannel(parameters.get("channel"));
    const sort = sortKey(parameters.get("sort"));
    const limit = listLimit(parameters.get("limit"));
    const since = instant(parameters.get("since"), "date filter");
    const until = instant(parameters.get("until"), "date filter");
    const beforeSortAt = instant(parameters.get("beforeSortAt"), "cursor");
    const beforeId = parameters.get("beforeId");
    const query = parameters.get("q");
    const owner = parameters.get("ownerUserId");
    const contactId = parameters.get("contactId");
    const agent = parameters.get("agentProfileVersionId");
    const unassigned = parameters.get("unassigned") === "true";
    // The filter object is built once and used for BOTH the page and the
    // count, so a badge can never describe a different set from the rows.
    const filter: LeadListOptions = {
      ...(status === undefined ? {} : { status }),
      ...(channel === undefined ? {} : { sourceChannel: channel }),
      ...(sort === undefined ? {} : { sort }),
      ...(query === null ? {} : { query }),
      ...(owner === null ? {} : { ownerUserId: owner }),
      ...(contactId === null ? {} : { contactId }),
      ...(agent === null ? {} : { agentProfileVersionId: agent }),
      ...(unassigned ? { unassigned } : {}),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    };
    // Paginated and counted server-side on purpose: a tenant's whole lead
    // history must never be shipped to a browser to be filtered there.
    const data = await withCurrentTenant("crm:read", async (sql) => {
      const [page, counts] = await Promise.all([
        listLeads(sql, {
          ...filter,
          ...(limit === undefined ? {} : { limit }),
          ...(beforeSortAt === undefined ? {} : { beforeSortAt }),
          ...(beforeId === null ? {} : { beforeId }),
        }),
        countLeads(sql, filter),
      ]);
      return { ...page, counts };
    });
    return NextResponse.json(data);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
