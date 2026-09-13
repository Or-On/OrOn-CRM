import { NextResponse } from "next/server";
import { simulationRefusal } from "../../../features/simulation-policy";

import { createSimulatorBroadcast, listBroadcasts } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../features/crm-route";

export async function GET() {
  try {
    return NextResponse.json({
      broadcasts: await withCurrentTenant("crm:read", listBroadcasts),
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const refusal = simulationRefusal();
    if (refusal) return refusal;
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (typeof body.name !== "string" || typeof body.body !== "string")
      throw new TypeError("campaign name and message are required");
    const id = await withCurrentTenant("campaigns:manage", (sql, session) =>
      createSimulatorBroadcast(
        sql,
        session.userId,
        body.name as string,
        body.body as string,
      ),
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
