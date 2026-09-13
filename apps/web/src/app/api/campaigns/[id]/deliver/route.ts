import { NextResponse } from "next/server";
import { simulationRefusal } from "../../../../../features/simulation-policy";

import { enqueueSimulatorBroadcast } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: RouteContext<"/api/campaigns/[id]/deliver">,
) {
  try {
    const refusal = simulationRefusal();
    if (refusal) return refusal;
    await assertCrmMutation(request);
    const { id } = await context.params;
    const queued = await withCurrentTenant("campaigns:manage", (sql) =>
      enqueueSimulatorBroadcast(sql, id),
    );
    return NextResponse.json(
      { queued, provider: "simulator" },
      { status: 202 },
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
