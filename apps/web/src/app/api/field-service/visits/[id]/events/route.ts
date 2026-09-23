import { NextResponse } from "next/server";
import { recordVisitEvent, requireFieldService } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import { uuid } from "../../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

function event(value: unknown): "en_route" | "work_started" | "work_completed" {
  if (
    value !== "en_route" &&
    value !== "work_started" &&
    value !== "work_completed"
  )
    throw new TypeError("Choose a supported visit event");
  return value;
}

/** Explicit technician events; the server clock records the time. */
export async function POST(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const visitId = uuid(id, "Visit");
    const body = await jsonObject(request);
    const selected = event(body.event);
    const times = await withCurrentTenant(
      "field-service:operate",
      async (sql) => {
        await requireFieldService(sql);
        return recordVisitEvent(sql, visitId, selected, requestId(request));
      },
    );
    return NextResponse.json({ times });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
