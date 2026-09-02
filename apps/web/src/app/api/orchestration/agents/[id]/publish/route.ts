import { NextResponse } from "next/server";

import { publishAgentProfile } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: RouteContext<"/api/orchestration/agents/[id]/publish">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const published = await withCurrentTenant("flows:manage", (sql, session) =>
      publishAgentProfile(sql, session.userId, id),
    );
    if (!published) throw new TypeError("no valid unpublished version exists");
    return NextResponse.json({ published: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
