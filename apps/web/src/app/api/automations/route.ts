import { NextResponse } from "next/server";

import { createAutomationDraft, listAutomations } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../features/crm-route";

export async function GET() {
  try {
    return NextResponse.json({
      automations: await withCurrentTenant("crm:read", listAutomations),
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (typeof body.name !== "string")
      throw new TypeError("automation name is required");
    const description =
      typeof body.description === "string" ? body.description : undefined;
    const id = await withCurrentTenant("flows:manage", (sql, session) =>
      createAutomationDraft(
        sql,
        session.userId,
        body.name as string,
        description,
      ),
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
