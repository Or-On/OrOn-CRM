import { NextResponse } from "next/server";

import { requireTenantFeature, summarizeTicketOutcomes } from "@or-on/crm";

import { withCurrentTenant } from "../../../../features/auth";
import { crmErrorResponse } from "../../../../features/crm-route";

const MAX_WINDOW_DAYS = 366;

function windowDays(value: string | null): number {
  if (value === null) return 30;
  if (!/^\d{1,3}$/u.test(value))
    throw new TypeError("metric window must be a whole number of days");
  const parsed = Number(value);
  if (parsed < 1 || parsed > MAX_WINDOW_DAYS)
    throw new TypeError(
      `metric window must be 1 to ${String(MAX_WINDOW_DAYS)} days`,
    );
  return parsed;
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const days = windowDays(parameters.get("days"));
    const until = new Date();
    const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
    // The window travels with the numbers: a resolution rate without the period
    // and the denominator it came from is not a measurement.
    const metrics = await withCurrentTenant("crm:read", async (sql) => {
      await requireTenantFeature(sql, "tickets");
      return summarizeTicketOutcomes(sql, {
        since: since.toISOString(),
        until: until.toISOString(),
      });
    });
    return NextResponse.json(metrics);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
