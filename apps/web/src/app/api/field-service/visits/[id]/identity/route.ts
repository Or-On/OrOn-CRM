import { NextResponse } from "next/server";
import { identifyTechnicianSession } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import {
  optionalText,
  text,
  uuid,
} from "../../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    const employeeIdentifier = optionalText(
      body.employeeIdentifier,
      "Employee identifier",
    );
    const contactInformation = optionalText(
      body.contactInformation,
      "Contact information",
    );
    const identityId = await withCurrentTenant(
      "field-service:operate",
      (sql, session) =>
        identifyTechnicianSession(sql, {
          authSessionId: session.sessionId,
          visitId: uuid(id, "Visit"),
          technicianId: uuid(body.technicianId, "Technician"),
          fullName: text(body.fullName, "Technician name"),
          ...(employeeIdentifier === undefined ? {} : { employeeIdentifier }),
          ...(contactInformation === undefined ? {} : { contactInformation }),
          requestId: requestId(request),
        }),
    );
    return NextResponse.json({ identityId }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
