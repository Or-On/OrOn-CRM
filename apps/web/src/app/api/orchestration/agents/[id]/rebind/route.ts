import { NextResponse } from "next/server";

import { rebindAgentConversations } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

/**
 * Explicitly move this agent's AI-owned conversations to its newest published
 * version. Publishing alone never does this; running calls are not affected
 * and keep the version they were admitted with.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/orchestration/agents/[id]/rebind">,
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (typeof body.versionId !== "string")
      throw new TypeError(
        "versionId is the published version being rebound to",
      );
    const { id } = await context.params;
    const result = await withCurrentTenant("flows:manage", (sql, session) =>
      rebindAgentConversations(
        sql,
        session.userId,
        id,
        body.versionId as string,
      ),
    );
    return result === null
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json(result);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
