import { NextResponse } from "next/server";
import { updateTenantProcess, type TenantProcessInput } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";

export async function PATCH(
  request: Request,
  context: { readonly params: Promise<{ id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (!Number.isInteger(body.expectedRevision))
      throw new TypeError("expectedRevision must be an integer");
    if (
      typeof body.name !== "string" ||
      typeof body.trigger !== "string" ||
      typeof body.enabled !== "boolean"
    )
      throw new TypeError("name, trigger and enabled are required");
    const { id } = await context.params;
    const process = await withCurrentTenant("tenant:manage", (sql, session) =>
      updateTenantProcess(
        sql,
        session.userId,
        id,
        body.expectedRevision as number,
        body as unknown as TenantProcessInput,
        requestId(request),
      ),
    );
    return NextResponse.json({ process });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
