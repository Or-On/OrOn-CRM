import { NextResponse } from "next/server";
import {
  applyTenantTemplate,
  tenantTemplateRegistry,
  type TenantTemplateKey,
} from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (typeof body.key !== "string" || !(body.key in tenantTemplateRegistry))
      throw new TypeError("unknown tenant template");
    const features = await withCurrentTenant("tenant:manage", (sql) =>
      applyTenantTemplate(sql, {
        key: body.key as TenantTemplateKey,
        requestId: requestId(request),
      }),
    );
    return NextResponse.json({ features });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
