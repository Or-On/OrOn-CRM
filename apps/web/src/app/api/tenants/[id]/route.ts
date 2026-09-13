import { deleteTenantForAdministrator } from "@or-on/crm";
import { NextResponse } from "next/server";

import {
  ForbiddenError,
  requestId,
  withCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function DELETE(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const deleted = await withCurrentTenant("platform:read", (sql, session) => {
      if (!session.isSuperuser) throw new ForbiddenError("Forbidden");
      return deleteTenantForAdministrator(sql, id, requestId(request));
    });
    if (!deleted)
      return NextResponse.json(
        { error: "The requested tenant was not found" },
        { status: 404 },
      );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
