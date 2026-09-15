import {
  deleteTenantForAdministrator,
  listPlatformTenants,
  setFieldServiceEntitlement,
} from "@or-on/crm";
import { NextResponse } from "next/server";

import {
  ForbiddenError,
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function PATCH(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const fieldServiceAvailable = body.fieldServiceAvailable;
    if (typeof fieldServiceAvailable !== "boolean")
      throw new TypeError("fieldServiceAvailable must be a boolean");
    const { id } = await context.params;
    const tenant = await withCurrentTenant(
      "platform:read",
      async (sql, session) => {
        if (!session.isSuperuser) throw new ForbiddenError("Forbidden");
        await setFieldServiceEntitlement(
          sql,
          id,
          fieldServiceAvailable,
          requestId(request),
        );
        return (await listPlatformTenants(sql)).find(
          (record) => record.id === id,
        );
      },
    );
    if (tenant === undefined)
      return NextResponse.json(
        { error: "The requested tenant was not found" },
        { status: 404 },
      );
    return NextResponse.json({ tenant });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

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
