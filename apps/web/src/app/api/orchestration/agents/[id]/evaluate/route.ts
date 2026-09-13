import { NextResponse } from "next/server";
import { evaluateAgentQuality } from "@or-on/crm";
import {
  jsonObject,
  withFreshCurrentTenant,
} from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    const evaluation = await withFreshCurrentTenant(
      "flows:manage",
      (sql, session) => evaluateAgentQuality(sql, session.userId, id, body),
    );
    return NextResponse.json({ evaluation });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
