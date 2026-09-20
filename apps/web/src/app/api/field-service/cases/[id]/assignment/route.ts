import { NextResponse } from "next/server";
import { assignServiceCase } from "@or-on/crm";
import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import { text, uuid } from "../../../../../../features/field-service";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const id = uuid((await context.params).id, "Service incident");
    const body = await jsonObject(request);
    return NextResponse.json(
      await withCurrentTenant("field-service:manage", (sql) =>
        assignServiceCase(
          sql,
          id,
          uuid(body.technicianId, "Technician"),
          text(body.reason, "Assignment reason"),
        ),
      ),
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
