import { NextResponse } from "next/server";
import {
  correctVisitTime,
  getVisitTimeline,
  requireFieldService,
  type CorrectableVisitTime,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import { uuid } from "../../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

const fields: readonly CorrectableVisitTime[] = [
  "en_route_at",
  "arrival_at",
  "work_started_at",
  "work_completed_at",
  "departure_at",
];

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const visitId = uuid(id, "Visit");
    const timeline = await withCurrentTenant(
      "field-service:read",
      async (sql) => {
        await requireFieldService(sql);
        return getVisitTimeline(sql, visitId);
      },
    );
    if (timeline === undefined)
      return NextResponse.json({ error: "Visit not found" }, { status: 404 });
    return NextResponse.json({ timeline });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

/** Owner/administrator correction; the previous value and reason are kept. */
export async function POST(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const visitId = uuid(id, "Visit");
    const body = await jsonObject(request);
    if (!fields.includes(body.field as CorrectableVisitTime))
      throw new TypeError("Choose a visit time to correct");
    if (typeof body.value !== "string" || typeof body.reason !== "string")
      throw new TypeError("A corrected time and a reason are required");
    const field = body.field as CorrectableVisitTime;
    const value = body.value;
    const reason = body.reason;
    const correctionId = await withCurrentTenant(
      "field-service:manage",
      async (sql) => {
        await requireFieldService(sql);
        return correctVisitTime(sql, { visitId, field, value, reason });
      },
    );
    return NextResponse.json({ correctionId });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
