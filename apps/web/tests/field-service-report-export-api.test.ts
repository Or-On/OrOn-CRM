import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createWorkbook: vi.fn(),
  getReport: vi.fn(),
  sql: Object.assign(vi.fn(), { json: (value: unknown) => value }),
}));

vi.mock("@or-on/crm", () => ({
  createServiceReportWorkbook: state.createWorkbook,
  getServiceReportDocument: state.getReport,
  safeArchiveSegment: (value: string) => value,
}));
vi.mock("../src/features/auth", () => ({
  requestId: () => "report-export-request",
  withCurrentTenant: (
    permission: string,
    operation: (
      sql: typeof state.sql,
      session: { readonly userId: string },
    ) => unknown,
  ) => {
    expect(permission).toBe("field-service:read");
    return operation(state.sql, {
      userId: "90000000-0000-4000-8000-000000000001",
    });
  },
}));
vi.mock("../src/features/crm-route", () => ({
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    ),
}));
vi.mock("../src/features/field-service", () => ({
  uuid: (value: unknown) => String(value),
}));

import { GET } from "../src/app/api/field-service/reports/[id]/export/route";

const revisionId = "10000000-0000-4000-8000-000000000001";

describe("field-service report export API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.sql.mockResolvedValue([]);
    state.getReport.mockResolvedValue({
      revision: {
        id: revisionId,
        reportId: "20000000-0000-4000-8000-000000000001",
        version: 3,
      },
      serviceCase: {
        id: "30000000-0000-4000-8000-000000000001",
        reference: "FS-2026-003",
      },
    });
    state.createWorkbook.mockReturnValue(Buffer.from("synthetic-xlsx"));
  });

  it("returns a private tenant-authorized XLSX and audits the export", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/field-service/reports/${revisionId}/export?format=xlsx`,
      ),
      { params: Promise.resolve({ id: revisionId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers.get("content-disposition")).toContain(
      "service-report-FS-2026-003.xlsx",
    );
    expect(state.createWorkbook).toHaveBeenCalledOnce();
    expect(state.sql).toHaveBeenCalledOnce();
  });

  it("rejects unknown formats before reading report data", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/field-service/reports/${revisionId}/export?format=pdf`,
      ),
      { params: Promise.resolve({ id: revisionId }) },
    );

    expect(response.status).toBe(400);
    expect(state.getReport).not.toHaveBeenCalled();
    expect(state.createWorkbook).not.toHaveBeenCalled();
  });
});
