import { NextResponse } from "next/server";
import { finalizeReportRevision } from "@or-on/crm";

import { requestId, withCurrentTenant } from "../../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../../features/crm-route";
import { uuid } from "../../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const report = await withCurrentTenant(
      "field-service:operate",
      (sql, session) =>
        finalizeReportRevision(
          sql,
          session.userId,
          uuid(id, "Report revision"),
          requestId(request),
        ),
    );
    return NextResponse.json({ report });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
