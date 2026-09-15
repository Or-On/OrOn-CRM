import { NextResponse } from "next/server";
import { assignContactClassification } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import { uuid } from "../../../../../../features/field-service";

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/crm/contacts/[id]/classifications">,
) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    if (typeof body.assigned !== "boolean")
      throw new TypeError("Assigned must be a boolean");
    await withCurrentTenant("crm:write", (sql, session) =>
      assignContactClassification(
        sql,
        session.userId,
        uuid(id, "Contact"),
        uuid(body.classificationId, "Classification"),
        body.assigned as boolean,
      ),
    );
    return NextResponse.json({ changed: true });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
