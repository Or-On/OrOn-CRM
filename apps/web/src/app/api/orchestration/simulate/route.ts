import { NextResponse } from "next/server";

import {
  queueCallOutcomeWhatsAppFollowup,
  queueWhatsAppTriggeredCall,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw new TypeError("idempotency-key is required");
    const command = await withCurrentTenant("flows:manage", (sql, session) => {
      if (body.kind === "call-outcome-whatsapp") {
        if (typeof body.sessionId !== "string")
          throw new TypeError("sessionId is required");
        return queueCallOutcomeWhatsAppFollowup(
          sql,
          session.userId,
          body.sessionId,
          idempotencyKey,
        );
      }
      if (body.kind === "whatsapp-crm-call") {
        if (typeof body.conversationId !== "string")
          throw new TypeError("conversationId is required");
        return queueWhatsAppTriggeredCall(
          sql,
          session.userId,
          body.conversationId,
          idempotencyKey,
        );
      }
      throw new TypeError("unknown simulation kind");
    });
    return NextResponse.json({ command }, { status: 202 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
