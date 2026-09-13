import { NextResponse } from "next/server";
import { simulationRefusal } from "../../../../../../features/simulation-policy";
import { queueCanonicalSimulation } from "@or-on/crm";
import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const refusal = simulationRefusal();
    if (refusal) return refusal;
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    const conversationId = body.conversationId,
      channel = body.channel;
    const key = request.headers.get("idempotency-key");
    if (
      typeof conversationId !== "string" ||
      !["voice", "whatsapp"].includes(String(channel)) ||
      !key
    )
      throw new TypeError(
        "conversation, channel and idempotency key are required",
      );
    const runId = await withCurrentTenant("flows:manage", (sql, session) =>
      queueCanonicalSimulation(
        sql,
        session.userId,
        id,
        conversationId,
        channel as "voice" | "whatsapp",
        key,
      ),
    );
    return NextResponse.json({ runId, mode: "simulator" }, { status: 202 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
