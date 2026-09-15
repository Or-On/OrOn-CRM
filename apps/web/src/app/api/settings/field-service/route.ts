import { NextResponse } from "next/server";
import { configureFieldService, getFieldServiceFeatureState } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";

export async function GET() {
  try {
    const feature = await withCurrentTenant("platform:read", (sql) =>
      getFieldServiceFeatureState(sql),
    );
    return NextResponse.json({ feature });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const boolean = (key: string) => {
      const value = body[key];
      if (typeof value !== "boolean")
        throw new TypeError(`${key} must be a boolean`);
      return value;
    };
    const calendarAccess = body.calendarAccess;
    if (
      calendarAccess !== "none" &&
      calendarAccess !== "read_only" &&
      calendarAccess !== "write"
    )
      throw new TypeError("calendarAccess is invalid");
    const calendarProvider =
      calendarAccess === "none" ? null : body.calendarProvider;
    if (calendarProvider !== null && calendarProvider !== "crm_calendar")
      throw new TypeError("calendarProvider is unsupported");
    const feature = await withCurrentTenant("tenant:manage", (sql) =>
      configureFieldService(sql, {
        enabled: boolean("enabled"),
        whatsAppIntakeEnabled: boolean("whatsAppIntakeEnabled"),
        aiSchedulingEnabled: boolean("aiSchedulingEnabled"),
        ocrEnabled: boolean("ocrEnabled"),
        sharedTechnicianLoginEnabled: boolean("sharedTechnicianLoginEnabled"),
        aiScheduleRequiresApproval: boolean("aiScheduleRequiresApproval"),
        calendarAccess,
        calendarProvider,
        requestId: requestId(request),
      }),
    );
    return NextResponse.json({ feature });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
