import { NextResponse } from "next/server";

import { updateCurrentTenantName, updateTenantSettings } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../features/crm-route";

export async function PATCH(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      typeof body.defaultCurrency !== "string" ||
      typeof body.locale !== "string" ||
      typeof body.timezone !== "string" ||
      typeof body.tenantName !== "string" ||
      (body.displayName !== null && typeof body.displayName !== "string")
    ) {
      throw new TypeError("invalid workspace settings");
    }
    const result = await withCurrentTenant("tenant:manage", async (sql) => {
      const settings = await updateTenantSettings(sql, {
        displayName: body.displayName as string | null,
        defaultCurrency: body.defaultCurrency as string,
        locale: body.locale as string,
        timezone: body.timezone as string,
      });
      const tenantName = await updateCurrentTenantName(
        sql,
        body.tenantName as string,
        requestId(request),
      );
      return { settings, tenantName };
    });
    return NextResponse.json(result);
  } catch (error) {
    return crmErrorResponse(error);
  }
}
