import { NextResponse } from "next/server";

import { createAgentProfileDraft, listAgentProfiles } from "@or-on/crm";

import {
  capabilities,
  channels,
} from "../../../../features/agent-configuration";
import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function GET() {
  try {
    return NextResponse.json({
      agents: await withCurrentTenant("crm:read", listAgentProfiles),
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (typeof body.name !== "string" || typeof body.systemPrompt !== "string")
      throw new TypeError("name and systemPrompt are required");
    const id = await withCurrentTenant("flows:manage", (sql, session) =>
      createAgentProfileDraft(sql, session.userId, {
        name: body.name as string,
        systemPrompt: body.systemPrompt as string,
        ...(typeof body.description === "string"
          ? { description: body.description }
          : {}),
        ...(typeof body.locale === "string" ? { locale: body.locale } : {}),
        channels: channels(body.channels),
        toolPermissions: capabilities(body.capabilities),
        ...(typeof body.roleTitle === "string"
          ? { roleTitle: body.roleTitle }
          : {}),
        ...(typeof body.leadFieldSchemaId === "string"
          ? { leadFieldSchemaId: body.leadFieldSchemaId }
          : {}),
      }),
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
