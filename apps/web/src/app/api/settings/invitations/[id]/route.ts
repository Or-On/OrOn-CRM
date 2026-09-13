import { NextResponse } from "next/server";

import { revokeTenantInvitation } from "@or-on/crm";

import { requestId, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function DELETE(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const { id } = await params;
    if (!uuidPattern.test(id))
      throw new TypeError("invalid invitation identifier");
    const revoked = await withCurrentTenant("members:manage", (sql) =>
      revokeTenantInvitation(sql, id, requestId(request)),
    );
    return revoked
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
