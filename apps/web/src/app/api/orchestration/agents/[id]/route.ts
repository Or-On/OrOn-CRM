import { NextResponse } from "next/server";

import {
  archiveAgentProfile,
  createAgentProfileRevision,
  renameAgentProfile,
  setDefaultWhatsAppAgent,
} from "@or-on/crm";

import {
  capabilities,
  channels,
} from "../../../../../features/agent-configuration";
import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

/**
 * Draft a new version of an existing agent.
 *
 * The revision starts unpublished on purpose: an interaction already running
 * on the published version keeps that version's prompt and permissions until
 * the operator publishes this one and rebinds.
 */
async function revise(profileId: string, body: Record<string, unknown>) {
  if (typeof body.systemPrompt !== "string")
    throw new TypeError("systemPrompt is required to revise an agent");
  if (typeof body.baseVersionId !== "string")
    throw new TypeError("baseVersionId is required to revise an agent");
  const revision = await withCurrentTenant("flows:manage", (sql, session) =>
    createAgentProfileRevision(sql, session.userId, profileId, {
      baseVersionId: body.baseVersionId as string,
      systemPrompt: body.systemPrompt as string,
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
  return revision === null
    ? NextResponse.json({ error: "Not found" }, { status: 404 })
    : NextResponse.json(revision, { status: 201 });
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/orchestration/agents/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const { id } = await context.params;
    if (body.systemPrompt !== undefined) return await revise(id, body);
    const updated = await withCurrentTenant("flows:manage", (sql, session) =>
      body.defaultWhatsApp === true
        ? setDefaultWhatsAppAgent(sql, session.userId, id)
        : typeof body.name === "string"
          ? renameAgentProfile(sql, session.userId, id, body.name)
          : Promise.reject(
              new TypeError("agent name or default selection is required"),
            ),
    );
    return updated
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/orchestration/agents/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const result = await withCurrentTenant("flows:manage", (sql, session) =>
      archiveAgentProfile(sql, session.userId, id),
    );
    if (result === "active")
      return NextResponse.json(
        {
          error:
            "Move active conversations to human ownership before deleting this agent.",
        },
        { status: 409 },
      );
    return result === "archived"
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
