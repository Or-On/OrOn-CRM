import { NextResponse } from "next/server";
import {
  approveAppointmentSuggestion,
  cancelServiceAppointment,
  rescheduleServiceAppointment,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";
import { optionalText, uuid } from "../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

export async function PATCH(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    const appointmentId = uuid(id, "Appointment");
    if (
      body.action !== "approve" &&
      body.action !== "cancel" &&
      body.action !== "reschedule"
    )
      throw new TypeError(
        "Appointment action must be approve, reschedule, or cancel",
      );
    const changed = await withCurrentTenant(
      "field-service:operate",
      async (sql, session) => {
        if (body.action === "approve") {
          await approveAppointmentSuggestion(
            sql,
            session.userId,
            appointmentId,
          );
          return true;
        }
        if (body.action === "reschedule") {
          await rescheduleServiceAppointment(
            sql,
            session.userId,
            appointmentId,
            {
              technicianId: uuid(body.technicianId, "Technician"),
              startsAt: typeof body.startsAt === "string" ? body.startsAt : "",
              endsAt: typeof body.endsAt === "string" ? body.endsAt : "",
              timezone: typeof body.timezone === "string" ? body.timezone : "",
              ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
              idempotencyKey:
                request.headers.get("idempotency-key") ?? crypto.randomUUID(),
            },
          );
          return true;
        }
        return cancelServiceAppointment(
          sql,
          session.userId,
          appointmentId,
          optionalText(body.reason, "Cancellation reason") ?? undefined,
        );
      },
    );
    if (!changed)
      return NextResponse.json(
        {
          error:
            "Appointment could not be cancelled; reconcile any external event first",
        },
        { status: 409 },
      );
    return NextResponse.json({ changed: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
