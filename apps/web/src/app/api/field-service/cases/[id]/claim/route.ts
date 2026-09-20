import { NextResponse } from "next/server";
import { assignServiceCase } from "@or-on/crm";
import { withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import { uuid } from "../../../../../../features/field-service";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await assertCrmMutation(request);
    const id = uuid((await context.params).id, "Service incident");
    return NextResponse.json(
      await withCurrentTenant("field-service:operate", (sql) =>
        assignServiceCase(sql, id),
      ),
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
