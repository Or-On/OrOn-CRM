import { NextResponse } from "next/server";
import {
  getTenantFeatureSnapshot,
  setTenantFeature,
  tenantFeatureKeys,
  tenantFeatureRegistry,
  tenantTemplateRegistry,
  type TenantFeatureKey,
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

export async function GET() {
  try {
    const features = await withCurrentTenant(
      "platform:read",
      getTenantFeatureSnapshot,
    );
    return NextResponse.json({
      features,
      definitions: tenantFeatureRegistry,
      templates: tenantTemplateRegistry,
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      typeof body.key !== "string" ||
      !tenantFeatureKeys.includes(body.key as TenantFeatureKey)
    )
      throw new TypeError("unknown tenant feature");
    if (typeof body.enabled !== "boolean")
      throw new TypeError("enabled must be a boolean");
    if (!Number.isInteger(body.expectedRevision))
      throw new TypeError("expectedRevision must be an integer");
    const feature = await withCurrentTenant("tenant:manage", (sql) =>
      setTenantFeature(sql, {
        key: body.key as TenantFeatureKey,
        enabled: body.enabled as boolean,
        expectedRevision: body.expectedRevision as number,
        requestId: requestId(request),
      }),
    );
    return NextResponse.json({ feature });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
