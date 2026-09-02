import { NextResponse } from "next/server";

import {
  createCanonicalFlowDraft,
  listAutomations,
  parseCanonicalFlow,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function GET() {
  try {
    return NextResponse.json({
      flows: await withCurrentTenant("crm:read", listAutomations),
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      typeof body.name !== "string" ||
      typeof body.agentProfileVersionId !== "string" ||
      body.flow === null ||
      typeof body.flow !== "object"
    )
      throw new TypeError("name, agentProfileVersionId, and flow are required");
    const id = await withCurrentTenant("flows:manage", (sql, session) =>
      createCanonicalFlowDraft(
        sql,
        session.userId,
        body.name as string,
        body.agentProfileVersionId as string,
        parseCanonicalFlow(body.flow),
      ),
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
