import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { listMessages, sendSimulatedReply } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/messaging/conversations/[id]/messages">,
) {
  try {
    const { id } = await context.params;
    const messages = await withCurrentTenant("crm:read", (sql) =>
      listMessages(sql, id),
    );
    return NextResponse.json({ messages });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/messaging/conversations/[id]/messages">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    if (typeof body.text !== "string")
      throw new TypeError("reply text is required");
    const suppliedIdempotencyKey = request.headers
      .get("idempotency-key")
      ?.trim();
    const idempotencyKey =
      suppliedIdempotencyKey === undefined || suppliedIdempotencyKey === ""
        ? randomUUID()
        : suppliedIdempotencyKey;
    const message = await withCurrentTenant(
      "messaging:operate",
      (sql, session) =>
        sendSimulatedReply(sql, {
          conversationId: id,
          senderUserId: session.userId,
          text: body.text as string,
          idempotencyKey,
        }),
    );
    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
