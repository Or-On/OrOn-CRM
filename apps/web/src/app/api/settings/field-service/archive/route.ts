import { NextResponse } from "next/server";

import { listServiceCasesForArchive } from "@or-on/crm";

import { withCurrentTenant } from "../../../../../features/auth";
import { crmErrorResponse } from "../../../../../features/crm-route";

function csvCell(value: string): string {
  // Quoting handles separators/newlines; prefixing formula markers prevents a
  // customer-supplied value from becoming executable spreadsheet content.
  const safe = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  try {
    const records = await withCurrentTenant(
      "tenant:manage",
      async (sql, session) => {
        const archive = await listServiceCasesForArchive(sql);
        if (!archive.complete)
          throw new TypeError(
            `The archive contains more than the explicit ${String(archive.maximumRecords)}-case synchronous export limit. No partial file was generated.`,
          );
        await sql`
        INSERT INTO audit.records(
          tenant_id, actor_user_id, action, target_type, target_id, metadata
        ) VALUES (
          platform.current_tenant_id(), ${session.userId}::uuid,
          'field_service.archive.index_exported', 'tenant',
          ${session.tenant.tenantId}::uuid,
          ${sql.json({
            caseCount: archive.records.length,
            complete: archive.complete,
            maximumRecords: archive.maximumRecords,
          })}
        )
      `;
        return archive;
      },
    );
    if (new URL(request.url).searchParams.get("format") === "json") {
      return NextResponse.json(
        {
          generatedAt: new Date().toISOString(),
          complete: records.complete,
          maximumRecords: records.maximumRecords,
          recordCount: records.records.length,
          records: records.records.map((record) => ({
            ...record,
            dossierPath: `/api/settings/field-service/archive/${record.id}`,
            dossierArchivePath: `/api/settings/field-service/archive/${record.id}?format=zip`,
          })),
        },
        {
          headers: {
            "cache-control": "private, no-store",
            "content-disposition":
              'attachment; filename="field-service-archive-index.json"',
            "x-content-type-options": "nosniff",
            "x-export-complete": String(records.complete),
            "x-export-record-count": String(records.records.length),
          },
        },
      );
    }
    const header = [
      "case_id",
      "dossier_path",
      "archive_zip_path",
      "reference",
      "customer_name",
      "location",
      "status",
      "title",
      "fault_description",
      "warranty_status",
      "product_model",
      "serial_number",
      "priority",
      "created_at",
      "updated_at",
    ];
    const rows = records.records.map((record) =>
      [
        record.id,
        `/api/settings/field-service/archive/${record.id}`,
        `/api/settings/field-service/archive/${record.id}?format=zip`,
        record.reference,
        record.customerName,
        record.serviceLocationName ?? "",
        record.status,
        record.title,
        record.faultDescription,
        record.warrantyStatus,
        record.productModel ?? "",
        record.serialNumber ?? "",
        record.priority,
        record.createdAt,
        record.updatedAt,
      ]
        .map(csvCell)
        .join(","),
    );
    return new NextResponse(
      `\uFEFF${header.join(",")}\r\n${rows.join("\r\n")}`,
      {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition":
            'attachment; filename="field-service-archive.csv"',
          "content-type": "text/csv; charset=utf-8",
          "x-content-type-options": "nosniff",
          "x-export-complete": String(records.complete),
          "x-export-record-count": String(records.records.length),
        },
      },
    );
  } catch (error) {
    return crmErrorResponse(error);
  }
}
