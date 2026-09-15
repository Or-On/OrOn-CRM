import { NextResponse } from "next/server";
import { createTechnician, listTechnicians } from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { optionalText, text, uuid } from "../../../../features/field-service";

export async function GET() {
  try {
    const technicians = await withCurrentTenant("field-service:read", (sql) =>
      listTechnicians(sql),
    );
    return NextResponse.json({ technicians });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const employeeIdentifier = optionalText(
      body.employeeIdentifier,
      "Employee identifier",
    );
    const phone = optionalText(body.phone, "Phone");
    const email = optionalText(body.email, "Email");
    const id = await withCurrentTenant("field-service:manage", (sql, session) =>
      createTechnician(sql, session.userId, {
        fullName: text(body.fullName, "Technician name"),
        ...(body.linkedUserId === undefined || body.linkedUserId === null
          ? {}
          : { linkedUserId: uuid(body.linkedUserId, "Linked user") }),
        ...(employeeIdentifier === undefined ? {} : { employeeIdentifier }),
        ...(phone === undefined ? {} : { phone }),
        ...(email === undefined ? {} : { email }),
        verified: body.verified === true,
      }),
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
