import { NextResponse } from "next/server";

import { updateTenantMember } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function PATCH(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const { id } = await params;
    const body = await jsonObject(request);
    if (
      !uuidPattern.test(id) ||
      (body.role !== "owner" &&
        body.role !== "admin" &&
        body.role !== "agent" &&
        body.role !== "technician" &&
        body.role !== "viewer")
    ) {
      throw new TypeError("invalid membership update");
    }
    await withCurrentTenant("members:change-role", (sql) =>
      updateTenantMember(sql, {
        userId: id,
        role: body.role as
          "owner" | "admin" | "agent" | "technician" | "viewer",
        requestId: requestId(request),
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const { id } = await params;
    if (!uuidPattern.test(id))
      throw new TypeError("invalid membership identifier");
    await withCurrentTenant("members:manage", (sql) =>
      updateTenantMember(sql, {
        userId: id,
        role: "viewer",
        remove: true,
        requestId: requestId(request),
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
