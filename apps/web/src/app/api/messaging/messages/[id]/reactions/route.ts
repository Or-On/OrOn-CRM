import { NextResponse } from "next/server";

import { addMessageReaction } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: RouteContext<"/api/messaging/messages/[id]/reactions">,
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (typeof body.emoji !== "string")
      throw new TypeError("emoji is required");
    const { id } = await context.params;
    await withCurrentTenant("messaging:operate", (sql, session) =>
      addMessageReaction(sql, id, session.userId, body.emoji as string),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
