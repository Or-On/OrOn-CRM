import { NextResponse } from "next/server";

import {
  archiveAgentProfile,
  renameAgentProfile,
  setDefaultWhatsAppAgent,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/orchestration/agents/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const { id } = await context.params;
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
