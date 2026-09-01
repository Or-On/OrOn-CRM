import { NextResponse } from "next/server";

import { deliverSimulatorBroadcast } from "@or-on/crm";

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
    await assertCrmMutation(request);
    const { id } = await context.params;
    const delivered = await withCurrentTenant("campaigns:manage", (sql) =>
      deliverSimulatorBroadcast(sql, id),
    );
    return NextResponse.json({ delivered, provider: "simulator" });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
