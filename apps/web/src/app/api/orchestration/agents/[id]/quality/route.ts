import { NextResponse } from "next/server";
import {
  createAgentQualityDraft,
  listAgentQualityVersions,
  listAgentVoiceBindings,
} from "@or-on/crm";
import {
  jsonObject,
  withCurrentTenant,
  withFreshCurrentTenant,
} from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}
export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const { versions, voiceBindings } = await withCurrentTenant(
      "flows:manage",
      async (sql) => ({
        versions: await listAgentQualityVersions(sql, id),
        voiceBindings: await listAgentVoiceBindings(sql, id),
      }),
    );
    return NextResponse.json({ versions, voiceBindings });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const body = await jsonObject(request);
    const versionId = await withFreshCurrentTenant(
      "flows:manage",
      (sql, session) => createAgentQualityDraft(sql, session.userId, id, body),
    );
    return NextResponse.json({ id: versionId }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
