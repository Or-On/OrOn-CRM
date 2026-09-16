import { NextResponse } from "next/server";
import { deleteServiceReport, saveReportDraft } from "@or-on/crm";

import {
  jsonObject,
  requestId,
  withCurrentTenant,
} from "../../../../../features/auth";
import {
  assertCrmMutation,
  crmErrorResponse,
} from "../../../../../features/crm-route";
import { optionalText, uuid } from "../../../../../features/field-service";

interface Context {
  readonly params: Promise<{ readonly id: string }>;
}

export async function PATCH(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const [{ id }, body] = await Promise.all([
      context.params,
      jsonObject(request),
    ]);
    if (
      body.partReplaced !== undefined &&
      body.partReplaced !== null &&
      typeof body.partReplaced !== "boolean"
    )
      throw new TypeError("Part replaced must be yes, no, or unanswered");
    const diagnosis = optionalText(body.diagnosis, "Diagnosis");
    const workPerformed = optionalText(body.workPerformed, "Work performed");
    const replacementPartDetails = optionalText(
      body.replacementPartDetails,
      "Replacement part details",
    );
    const technicianNotes = optionalText(
      body.technicianNotes,
      "Technician notes",
    );
    const report = await withCurrentTenant(
      "field-service:operate",
      (sql, session) =>
        saveReportDraft(
          sql,
          session.userId,
          uuid(id, "Report revision"),
          {
            ...(diagnosis === undefined ? {} : { diagnosis }),
            ...(workPerformed === undefined ? {} : { workPerformed }),
            ...(body.partReplaced === undefined
              ? {}
              : { partReplaced: body.partReplaced as boolean | null }),
            ...(replacementPartDetails === undefined
              ? {}
              : { replacementPartDetails }),
            ...(technicianNotes === undefined ? {} : { technicianNotes }),
          },
          requestId(request),
        ),
    );
    return NextResponse.json({ report });
  } catch (error) {
    return crmErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    await assertCrmMutation(request);
    const { id } = await context.params;
    const deleted = await withCurrentTenant(
      "field-service:operate",
      (sql, session) =>
        deleteServiceReport(
          sql,
          session.userId,
          uuid(id, "Report revision"),
          requestId(request),
        ),
    );
    return NextResponse.json({ deleted: true, reportId: deleted.reportId });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
