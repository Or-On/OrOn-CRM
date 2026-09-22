import { NextResponse } from "next/server";
import {
  bindTechnicianSession,
  getTechnicianSessionContext,
  releaseTechnicianSession,
} from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
  withFreshCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { optionalText, text } from "../../../../features/field-service";

/**
 * The physical technician of the calling browser session. The session, user
 * and tenant always come from the authenticated cookie, and the technician is
 * resolved by PostgreSQL from the details typed on the device; no request may
 * name a technician identifier.
 */
export async function GET() {
  try {
    const context = await withCurrentTenant("field-service:operate", (sql) =>
      getTechnicianSessionContext(sql),
    );
    return NextResponse.json(context, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    if (
      "technicianId" in body ||
      "sessionId" in body ||
      "userId" in body ||
      "tenantId" in body
    )
      throw new TypeError(
        "The technician is resolved from the details typed on this device",
      );
    const phone = optionalText(body.phone, "Contact number");
    const technician = await withFreshCurrentTenant(
      "field-service:operate",
      (sql) =>
        bindTechnicianSession(sql, {
          fullName: text(body.fullName, "Full name"),
          employeeIdentifier: text(body.employeeIdentifier, "Employee ID"),
          ...(phone === undefined ? {} : { phone }),
          requestId: requestId(request),
        }),
    );
    return NextResponse.json({ technician });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await assertCrmMutation(request);
    const released = await withFreshCurrentTenant(
      "field-service:operate",
      (sql) => releaseTechnicianSession(sql, requestId(request)),
    );
    return NextResponse.json({ released });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
