import { NextResponse } from "next/server";

import { revokeApiKey } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/settings/api-keys/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const revoked = await withCurrentTenant("tenant:manage", (sql) =>
      revokeApiKey(sql, id),
    );
    return revoked
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
