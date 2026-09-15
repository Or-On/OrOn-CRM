import { NextResponse } from "next/server";
import { createServiceVisit } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { uuid } from "../../../../features/field-service";

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const visit = await withCurrentTenant(
      "field-service:operate",
      (sql, session) =>
        createServiceVisit(
          sql,
          session.userId,
          uuid(body.caseId, "Case"),
          uuid(body.technicianId, "Technician"),
          body.appointmentId === undefined || body.appointmentId === null
            ? undefined
            : uuid(body.appointmentId, "Appointment"),
          requestId(request),
        ),
    );
    return NextResponse.json({ visit }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
