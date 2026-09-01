import { NextResponse } from "next/server";

import { moveDeal } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: RouteContext<"/api/crm/deals/[id]/stage">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    if (typeof body.stageId !== "string")
      throw new TypeError("stageId is required");
    const moved = await withCurrentTenant("pipelines:manage", (sql) =>
      moveDeal(sql, id, body.stageId as string),
    );
    return moved
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
