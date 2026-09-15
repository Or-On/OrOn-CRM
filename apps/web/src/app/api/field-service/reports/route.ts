import { NextResponse } from "next/server";
import { openReportDraft } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../features/crm-route";
import { uuid } from "../../../../features/field-service";

export async function POST(request: Request) {
  try {
    await assertCrmMutation(request);
    const body = await jsonObject(request);
    const report = await withCurrentTenant(
      "field-service:operate",
      (sql, session) =>
        openReportDraft(
          sql,
          session.userId,
          uuid(body.caseId, "Case"),
          uuid(body.visitId, "Visit"),
          requestId(request),
        ),
    );
    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
