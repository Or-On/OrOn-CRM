import { NextResponse } from "next/server";

import {
  listHandoffs,
  requestHandoff,
  supportedChannels,
  type SupportedChannel,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function GET() {
  try {
    return NextResponse.json({
      handoffs: await withCurrentTenant("crm:read", listHandoffs),
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
      typeof body.contactId !== "string" ||
      typeof body.sourceChannel !== "string" ||
      !supportedChannels.includes(body.sourceChannel as SupportedChannel) ||
      typeof body.reasonSafe !== "string"
    )
      throw new TypeError("valid contact, channel, and reason are required");
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw new TypeError("idempotency-key is required");
    const handoff = await withCurrentTenant(
      "messaging:operate",
      (sql, session) =>
        requestHandoff(
          sql,
          session.userId,
          body.contactId as string,
          body.sourceChannel as SupportedChannel,
          body.reasonSafe as string,
          idempotencyKey,
        ),
    );
    return NextResponse.json({ handoff }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
