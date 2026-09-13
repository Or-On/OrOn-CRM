import { NextResponse } from "next/server";
import { simulationRefusal } from "../../../../../features/simulation-policy";

import { runManualAutomation } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: RouteContext<"/api/automations/[id]/run">,
) {
  try {
    const refusal = simulationRefusal();
    if (refusal) return refusal;
    await assertCrmMutation(request);
    const { id } = await context.params;
    const runId = await withCurrentTenant("flows:manage", (sql) =>
      runManualAutomation(sql, id),
    );
    return NextResponse.json(
      { runId, mode: "simulator", noOp: true },
      { status: 201 },
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
