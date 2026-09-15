import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { finalizeReportRevision } from "./field-service.js";

const actorUserId = "10000000-0000-4000-8000-000000000001";
const reportId = "20000000-0000-4000-8000-000000000001";
const revisionId = "30000000-0000-4000-8000-000000000001";

function transaction(results: readonly unknown[][]) {
  const statements: string[] = [];
  const execute = vi.fn((parts: TemplateStringsArray) => {
    statements.push(parts.join("?"));
    return Promise.resolve(results[statements.length - 1] ?? []);
  });
  const sql = Object.assign(execute, {
    json: (value: unknown) => value,
  }) as unknown as postgres.TransactionSql;
  return { sql, statements };
}

describe("field-service report finalization", () => {
  it("captures branding through the narrow tenant-name boundary", async () => {
    const finalizedAt = new Date("2026-09-15T14:00:00.000Z");
    const fixture = transaction([
      [{ available: true, enabled: true }],
      [
        {
          id: revisionId,
          report_id: reportId,
          version: 1,
          status: "draft",
          diagnosis: "Synthetic diagnosis",
          work_performed: "Synthetic repair",
          part_replaced: false,
          replacement_part_details: null,
          technician_notes: null,
          finalized_at: null,
          arrival_signed: true,
          departure_signed: true,
          has_fault_photo: true,
          has_module_photo: true,
        },
      ],
      [],
      [
        {
          id: revisionId,
          report_id: reportId,
          version: 1,
          status: "finalized",
          diagnosis: "Synthetic diagnosis",
          work_performed: "Synthetic repair",
          part_replaced: false,
          replacement_part_details: null,
          technician_notes: null,
          finalized_at: finalizedAt,
        },
      ],
      [],
      [],
    ]);

    await expect(
      finalizeReportRevision(
        fixture.sql,
        actorUserId,
        revisionId,
        "finalize-request",
      ),
    ).resolves.toMatchObject({
      id: revisionId,
      reportId,
      status: "finalized",
      finalizedAt: finalizedAt.toISOString(),
    });

    const finalization = fixture.statements[3] ?? "";
    expect(finalization).toContain("platform.current_tenant_name()");
    expect(finalization).not.toContain("public.tenants");
    expect(finalization).toContain(
      "settings.tenant_id = platform.current_tenant_id()",
    );
    expect(finalization).toContain("'signedDocument', jsonb_build_object(");
    expect(finalization).toContain("'customerName', customer.name");
    expect(finalization).toContain("'fullName', technician.full_name");
    expect(finalization).toContain("'serviceLocationName', location.name");
  });
});
