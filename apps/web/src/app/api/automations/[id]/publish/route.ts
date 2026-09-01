import { NextResponse } from "next/server";

import { publishAutomation } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: RouteContext<"/api/automations/[id]/publish">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const published = await withCurrentTenant("flows:manage", (sql) =>
      publishAutomation(sql, id),
    );
    return published
      ? NextResponse.json({ published: true })
      : NextResponse.json({ error: "No valid draft" }, { status: 409 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
