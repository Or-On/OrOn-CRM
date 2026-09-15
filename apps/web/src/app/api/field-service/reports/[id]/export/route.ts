import { NextResponse } from "next/server";

import {
  createServiceReportWorkbook,
  getServiceReportDocument,
  safeArchiveSegment,
} from "@or-on/crm";

import { requestId, withCurrentTenant } from "../../../../../../features/auth";
import { crmErrorResponse } from "../../../../../../features/crm-route";
import { uuid } from "../../../../../../features/field-service";

export async function GET(
  request: Request,
  context: RouteContext<"/api/field-service/reports/[id]/export">,
) {
  try {
    const format = new URL(request.url).searchParams.get("format");
    if (format !== "xlsx")
      throw new TypeError("Supported report export format is xlsx");
    const { id } = await context.params;
    const revisionId = uuid(id, "Report revision");
    const exported = await withCurrentTenant(
      "field-service:read",
      async (sql, session) => {
        const report = await getServiceReportDocument(sql, revisionId);
        if (report === undefined) return undefined;
        const bytes = createServiceReportWorkbook(report);
        await sql`
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id, request_id,
            metadata
          ) VALUES (
            platform.current_tenant_id(), ${session.userId}::uuid,
            'field_service.report.xlsx_exported', 'report_revision',
            ${revisionId}::uuid, ${requestId(request)},
            ${sql.json({
              byteSize: bytes.byteLength,
              caseId: report.serviceCase.id,
              reportId: report.revision.reportId,
              version: report.revision.version,
            })}
          )
        `;
        return { bytes, reference: report.serviceCase.reference };
      },
    );
    if (exported === undefined)
      return NextResponse.json(
        { error: "Finalized report not found" },
        { status: 404 },
      );
    const filename = `service-report-${safeArchiveSegment(exported.reference)}.xlsx`;
    return new NextResponse(Uint8Array.from(exported.bytes).buffer, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(exported.bytes.byteLength),
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return crmErrorResponse(error);
  }
}
