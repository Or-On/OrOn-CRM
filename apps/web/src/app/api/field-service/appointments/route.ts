import { NextResponse } from "next/server";
import {
  listServiceAppointments,
  scheduleServiceAppointment,
  suggestNextServiceAppointment,
} from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { optionalText, text, uuid } from "../../../../features/field-service";

export async function GET(request: Request) {
  try {
    const caseId = new URL(request.url).searchParams.get("caseId");
    const appointments = await withCurrentTenant("field-service:read", (sql) =>
      listServiceAppointments(
        sql,
        caseId === null ? undefined : uuid(caseId, "Case"),
      ),
    );
    return NextResponse.json({ appointments });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const notes = optionalText(body.notes, "Scheduling notes");
    const idempotencyKey =
      request.headers.get("idempotency-key") ?? requestId(request);
    const appointment = await withCurrentTenant(
      "field-service:operate",
      (sql, session) => {
        if (body.action === "suggest") {
          const durationMinutes = Number(body.durationMinutes);
          return suggestNextServiceAppointment(sql, session.userId, {
            caseId: uuid(body.caseId, "Case"),
            earliestAt:
              typeof body.earliestAt === "string"
                ? body.earliestAt
                : new Date().toISOString(),
            durationMinutes,
            timezone: text(body.timezone, "Timezone"),
            ...(notes === undefined ? {} : { notes }),
            idempotencyKey,
          });
        }
        if (body.action !== undefined && body.action !== "schedule")
          throw new TypeError("Appointment action is invalid");
        return scheduleServiceAppointment(sql, session.userId, {
          caseId: uuid(body.caseId, "Case"),
          technicianId: uuid(body.technicianId, "Technician"),
          startsAt: text(body.startsAt, "Start time"),
          endsAt: text(body.endsAt, "End time"),
          timezone: text(body.timezone, "Timezone"),
          ...(notes === undefined ? {} : { notes }),
          source: "manual",
          idempotencyKey,
        });
      },
    );
    return NextResponse.json({ appointment }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
