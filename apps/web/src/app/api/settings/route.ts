import { NextResponse } from "next/server";

import { updateTenantSettings } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../features/auth";
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
      (body.displayName !== null && typeof body.displayName !== "string")
    ) {
      throw new TypeError("invalid workspace settings");
    }
    const settings = await withCurrentTenant("tenant:manage", (sql) =>
      updateTenantSettings(sql, {
        displayName: body.displayName as string | null,
        defaultCurrency: body.defaultCurrency as string,
        locale: body.locale as string,
        timezone: body.timezone as string,
      }),
    );
    return NextResponse.json({ settings });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
