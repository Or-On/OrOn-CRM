import { NextResponse } from "next/server";
import {
  bindTechnicianSession,
  getTechnicianSessionContext,
  listTechnicianSessionCandidates,
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
import { optionalText, uuid } from "../../../../features/field-service";

/**
 * The physical technician of the calling browser session. The session, user
 * and tenant always come from the authenticated cookie; the body may only
 * name a technician profile, which PostgreSQL validates before binding it.
 */
export async function GET() {
  try {
    const state = await withCurrentTenant(
      "field-service:operate",
      async (sql) => {
        const context = await getTechnicianSessionContext(sql);
        return {
          ...context,
          candidates:
            context.mode === "shared" && context.technician === null
              ? await listTechnicianSessionCandidates(sql)
              : [],
        };
      },
    );
    return NextResponse.json(state, {
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
    if ("sessionId" in body || "userId" in body || "tenantId" in body)
      throw new TypeError("The session is resolved from the signed-in device");
    const technicianId = uuid(body.technicianId, "Technician");
    const employeeIdentifier = optionalText(
      body.employeeIdentifier,
      "Employee ID",
    );
    const technician = await withFreshCurrentTenant(
      "field-service:operate",
      (sql) =>
        bindTechnicianSession(sql, {
          technicianId,
          ...(employeeIdentifier === undefined ? {} : { employeeIdentifier }),
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
