import { NextResponse } from "next/server";

import {
  archiveAutomation,
  renameAutomation,
  saveCanonicalFlowDraft,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/orchestration/flows/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const { id } = await context.params;
    if (Object.hasOwn(body, "flow")) {
      if (
        body.flow === null ||
        typeof body.flow !== "object" ||
        Array.isArray(body.flow)
      )
        throw new TypeError("flow definition is required");
      const saved = await withCurrentTenant("flows:manage", (sql, session) =>
        saveCanonicalFlowDraft(sql, session.userId, id, body.flow),
      );
      return saved === null
        ? NextResponse.json({ error: "Not found" }, { status: 404 })
        : NextResponse.json({ ok: true, ...saved });
    }
    if (typeof body.name !== "string")
      throw new TypeError("flow name is required");
    const updated = await withCurrentTenant("flows:manage", (sql, session) =>
      renameAutomation(sql, session.userId, id, body.name as string),
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
  context: RouteContext<"/api/orchestration/flows/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const archived = await withCurrentTenant("flows:manage", (sql, session) =>
      archiveAutomation(sql, session.userId, id),
    );
    return archived
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
