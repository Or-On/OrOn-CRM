import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  deleteServiceReport,
  getServiceReportDocument,
  listServiceReportPage,
} from "./field-service.js";

const reportRows = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    report_id: "20000000-0000-4000-8000-000000000001",
    version: 2,
    status: "finalized" as const,
    case_id: "30000000-0000-4000-8000-000000000001",
    case_reference: "FS-2026-0021",
    case_title: "Synthetic control-board fault",
    customer_contact_id: "40000000-0000-4000-8000-000000000001",
    customer_name: "Fictional Customer",
    visit_id: "50000000-0000-4000-8000-000000000001",
    visit_number: 2,
    technician_id: "60000000-0000-4000-8000-000000000001",
    technician_name: "Fictional Technician",
    finalized_at: new Date("2026-09-15T11:00:00.000Z"),
    created_at: new Date("2026-09-15T10:00:00.000Z"),
    updated_at: new Date("2026-09-15T11:00:00.000Z"),
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    report_id: "20000000-0000-4000-8000-000000000002",
    version: 1,
    status: "draft" as const,
    case_id: "30000000-0000-4000-8000-000000000002",
    case_reference: "FS-2026-0022",
    case_title: "Synthetic refrigeration fault",
    customer_contact_id: "40000000-0000-4000-8000-000000000002",
    customer_name: "Fictional Customer Two",
    visit_id: "50000000-0000-4000-8000-000000000002",
    visit_number: 1,
    technician_id: "60000000-0000-4000-8000-000000000002",
    technician_name: "Fictional Technician Two",
    finalized_at: null,
    created_at: new Date("2026-09-14T10:00:00.000Z"),
    updated_at: new Date("2026-09-14T10:00:00.000Z"),
  },
];

function transaction(rows: readonly (typeof reportRows)[number][]) {
  const execute = vi.fn().mockResolvedValue([
    {
      available: true,
      enabled: true,
      calendar_access: "none",
      whatsapp_channel_ready: false,
      whatsapp_agent_ready: false,
    },
  ]);
  const unsafe = vi
    .fn<
      (
        statement: string,
        parameters: readonly unknown[],
      ) => Promise<readonly (typeof reportRows)[number][]>
    >()
    .mockResolvedValue(rows);
  return {
    sql: Object.assign(execute, {
      unsafe,
    }) as unknown as postgres.TransactionSql,
    unsafe,
  };
}

describe("field-service report history", () => {
  it("maps a filtered keyset page and preserves the next stable cursor", async () => {
    const fixture = transaction(reportRows);

    await expect(
      listServiceReportPage(fixture.sql, {
        status: "finalized",
        query: "Fictional",
        limit: 1,
        cursor: {
          updatedAt: "2026-09-16T00:00:00.000Z",
          id: "10000000-0000-4000-8000-000000000099",
        },
      }),
    ).resolves.toEqual({
      reports: [
        {
          id: reportRows[0]?.id,
          reportId: reportRows[0]?.report_id,
          version: 2,
          status: "finalized",
          caseId: reportRows[0]?.case_id,
          caseReference: "FS-2026-0021",
          caseTitle: "Synthetic control-board fault",
          customerContactId: reportRows[0]?.customer_contact_id,
          customerName: "Fictional Customer",
          visitId: reportRows[0]?.visit_id,
          visitNumber: 2,
          technicianId: reportRows[0]?.technician_id,
          technicianName: "Fictional Technician",
          finalizedAt: "2026-09-15T11:00:00.000Z",
          createdAt: "2026-09-15T10:00:00.000Z",
          updatedAt: "2026-09-15T11:00:00.000Z",
        },
      ],
      nextCursor: {
        updatedAt: "2026-09-15T11:00:00.000Z",
        id: "10000000-0000-4000-8000-000000000001",
      },
    });

    const [statement, parameters] = fixture.unsafe.mock.calls[0] ?? [];
    expect(statement).toContain("revision.updated_at DESC, revision.id DESC");
    expect(statement).toContain("report.tenant_id = revision.tenant_id");
    expect(statement).toContain(
      "revision.tenant_id = platform.current_tenant_id()",
    );
    expect(statement).toContain("report.deleted_at IS NULL");
    expect(parameters).toEqual([
      "finalized",
      "Fictional",
      "2026-09-16T00:00:00.000Z",
      "10000000-0000-4000-8000-000000000099",
      2,
    ]);
  });

  it("rejects an invalid cursor before reading report rows", async () => {
    const fixture = transaction([]);

    await expect(
      listServiceReportPage(fixture.sql, {
        cursor: {
          updatedAt: "not-a-date",
          id: "10000000-0000-4000-8000-000000000001",
        },
      }),
    ).rejects.toThrow("cursor timestamp is invalid");
    expect(fixture.unsafe).not.toHaveBeenCalled();
  });

  it("reads both current and superseded signed revisions but not drafts", async () => {
    const statements: string[] = [];
    const results: readonly unknown[][] = [
      [{ available: true, enabled: true }],
      [],
    ];
    const execute = vi.fn((parts: TemplateStringsArray) => {
      statements.push(parts.join("?"));
      return Promise.resolve(results[statements.length - 1] ?? []);
    });
    const sql = Object.assign(execute, {
      json: (value: unknown) => value,
    }) as unknown as postgres.TransactionSql;

    await expect(
      getServiceReportDocument(sql, "10000000-0000-4000-8000-000000000001"),
    ).resolves.toBeUndefined();

    expect(statements[1]).toContain(
      "revision.status IN ('finalized', 'superseded')",
    );
    expect(statements[1]).toContain("report.deleted_at IS NULL");
    expect(statements[1]).not.toContain("revision.status='draft'");
  });

  it("tombstones the tenant-visible report aggregate and records its audit event", async () => {
    const statements: string[] = [];
    const results: readonly unknown[][] = [
      [{ available: true, enabled: true }],
      [
        {
          report_id: "20000000-0000-4000-8000-000000000001",
          case_id: "30000000-0000-4000-8000-000000000001",
        },
      ],
      [],
    ];
    const execute = vi.fn((parts: TemplateStringsArray) => {
      statements.push(parts.join("?"));
      return Promise.resolve(results[statements.length - 1] ?? []);
    });
    const json = vi.fn((value: unknown) => value);
    const sql = Object.assign(execute, {
      json,
    }) as unknown as postgres.TransactionSql;

    await expect(
      deleteServiceReport(
        sql,
        "40000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000001",
        "delete-report-request",
      ),
    ).resolves.toEqual({
      reportId: "20000000-0000-4000-8000-000000000001",
      caseId: "30000000-0000-4000-8000-000000000001",
    });

    expect(statements[1]).toContain(
      "revision.tenant_id = platform.current_tenant_id()",
    );
    expect(statements[1]).toContain("report.deleted_at IS NULL");
    expect(statements[1]).toContain("deleted_by_user_id");
    expect(statements[2]).toContain("field_service.report.deleted");
    expect(json).toHaveBeenCalledWith({
      caseId: "30000000-0000-4000-8000-000000000001",
      revisionId: "10000000-0000-4000-8000-000000000001",
    });
  });

  it("returns a not-found code for missing, cross-tenant, or already deleted reports", async () => {
    const results: readonly unknown[][] = [
      [{ available: true, enabled: true }],
      [],
    ];
    let call = 0;
    const execute = vi.fn(() => Promise.resolve(results[call++] ?? []));
    const sql = Object.assign(execute, {
      json: (value: unknown) => value,
    }) as unknown as postgres.TransactionSql;

    await expect(
      deleteServiceReport(
        sql,
        "40000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000099",
      ),
    ).rejects.toMatchObject({ code: "P0002" });
  });
});
