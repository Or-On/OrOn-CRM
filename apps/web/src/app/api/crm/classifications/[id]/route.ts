import { NextResponse } from "next/server";

import { updateCustomerClassification } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";
import {
  optionalText,
  text,
  uuid,
} from "../../../../../features/field-service";

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/crm/classifications/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    if (body.active !== undefined && typeof body.active !== "boolean")
      throw new TypeError("Active must be a boolean");
    const description = optionalText(body.description, "Description");
    const classification = await withCurrentTenant(
      "tenant:manage",
      (sql, session) =>
        updateCustomerClassification(
          sql,
          session.userId,
          uuid(id, "Classification"),
          {
            name: text(body.name, "Classification name"),
            color: text(body.color, "Classification color"),
            ...(description === undefined ? {} : { description }),
            ...(typeof body.active === "boolean"
              ? { active: body.active }
              : {}),
          },
        ),
    );
    return NextResponse.json({ classification });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
