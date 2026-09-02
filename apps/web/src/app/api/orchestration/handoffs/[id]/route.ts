import { NextResponse } from "next/server";

import { transitionHandoff } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/orchestration/handoffs/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (!["accept", "resolve", "cancel"].includes(String(body.action)))
      throw new TypeError("action must be accept, resolve, or cancel");
    const { id } = await context.params;
    const handoff = await withCurrentTenant(
      "messaging:operate",
      (sql, session) =>
        transitionHandoff(
          sql,
          id,
          session.userId,
          body.action as "accept" | "resolve" | "cancel",
        ),
    );
    return NextResponse.json({ handoff });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
