import { NextResponse } from "next/server";
import { updateTechnician } from "@or-on/crm";

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
  context: RouteContext<"/api/field-service/technicians/[id]">,
) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    if (body.active !== undefined && typeof body.active !== "boolean")
      throw new TypeError("Technician active state must be boolean");
    if (body.verified !== undefined && typeof body.verified !== "boolean")
      throw new TypeError("Technician verification state must be boolean");
    const linkedUserId =
      body.linkedUserId === null || body.linkedUserId === ""
        ? null
        : body.linkedUserId === undefined
          ? undefined
          : uuid(body.linkedUserId, "Linked user");
    const technician = await withCurrentTenant(
      "field-service:manage",
      (sql, session) =>
        updateTechnician(sql, session.userId, uuid(id, "Technician"), {
          ...(body.fullName === undefined
            ? {}
            : { fullName: text(body.fullName, "Technician name") }),
          ...(body.employeeIdentifier === undefined
            ? {}
            : {
                employeeIdentifier:
                  optionalText(
                    body.employeeIdentifier,
                    "Employee identifier",
                  ) ?? null,
              }),
          ...(body.phone === undefined
            ? {}
            : { phone: optionalText(body.phone, "Phone") ?? null }),
          ...(body.email === undefined
            ? {}
            : { email: optionalText(body.email, "Email") ?? null }),
          ...(linkedUserId === undefined ? {} : { linkedUserId }),
          ...(body.verified === undefined
            ? {}
            : { verified: body.verified as boolean }),
          ...(body.active === undefined
            ? {}
            : { active: body.active as boolean }),
        }),
    );
    if (technician === undefined)
      return NextResponse.json(
        { error: "Technician not found" },
        { status: 404 },
      );
    return NextResponse.json({ technician });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
