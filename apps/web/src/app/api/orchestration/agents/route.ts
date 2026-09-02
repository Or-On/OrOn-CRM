import { NextResponse } from "next/server";

import {
  createAgentProfileDraft,
  listAgentProfiles,
  supportedChannels,
  type SupportedChannel,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

function channels(value: unknown): readonly SupportedChannel[] {
  if (!Array.isArray(value)) throw new TypeError("channels must be an array");
  const parsed = value.filter(
    (entry): entry is SupportedChannel =>
      typeof entry === "string" &&
      supportedChannels.includes(entry as SupportedChannel),
  );
  if (parsed.length !== value.length)
    throw new TypeError("only voice and whatsapp channels are supported");
  return parsed;
}

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
      }),
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
