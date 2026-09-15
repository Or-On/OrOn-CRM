import { NextResponse } from "next/server";
import {
  getServiceCaseDossier,
  serviceCaseStatuses,
  transitionServiceCase,
  type ServiceCaseStatus,
} from "@or-on/crm";

import { jsonObject, withCurrentTenant } from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";
import { text, uuid } from "../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const dossier = await withCurrentTenant("field-service:read", (sql) =>
      getServiceCaseDossier(sql, uuid(id, "Case")),
    );
    if (dossier === undefined)
      return NextResponse.json(
        { error: "Service case not found" },
        { status: 404 },
      );
    return NextResponse.json({ dossier });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    if (!serviceCaseStatuses.includes(body.status as ServiceCaseStatus))
      throw new TypeError("Invalid service-case status");
    const serviceCase = await withCurrentTenant(
      "field-service:operate",
      (sql, session) =>
        transitionServiceCase(
          sql,
          { userId: session.userId },
          uuid(id, "Case"),
          body.status as ServiceCaseStatus,
          body.reason === undefined ? undefined : text(body.reason, "Reason"),
        ),
    );
    return NextResponse.json({ case: serviceCase });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
