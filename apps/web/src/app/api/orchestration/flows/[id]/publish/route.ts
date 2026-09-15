import { NextResponse } from "next/server";

import { publishExecutableFlow } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function POST(
  request: Request,
  context: RouteContext<"/api/orchestration/flows/[id]/publish">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const published = await withCurrentTenant("flows:manage", (sql, session) =>
      publishExecutableFlow(sql, session.userId, id),
    );
    if (!published)
      throw new TypeError(
        "publish a valid linked agent that supports every flow channel before publishing this flow",
      );
    return NextResponse.json({ published: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
