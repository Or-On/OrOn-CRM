import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assertMutation: vi.fn(),
  deleteReport: vi.fn(),
  tenant: vi.fn(),
}));

vi.mock("@or-on/crm", () => ({
  deleteServiceReport: state.deleteReport,
  saveReportDraft: vi.fn(),
}));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  requestId: () => "delete-report-request",
  withCurrentTenant: state.tenant,
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.assertMutation,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 403 },
    ),
}));
vi.mock("../src/features/field-service", () => ({
  optionalText: vi.fn(),
  uuid: (value: unknown) => String(value),
}));

import { DELETE } from "../src/app/api/field-service/reports/[id]/route";

const revisionId = "10000000-0000-4000-8000-000000000001";
const reportId = "20000000-0000-4000-8000-000000000001";

describe("field-service report deletion API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.assertMutation.mockResolvedValue(undefined);
    state.deleteReport.mockResolvedValue({ reportId, caseId: "case-id" });
    state.tenant.mockImplementation(
      async (
        permission: string,
        operation: (
          sql: unknown,
          session: { readonly userId: string },
        ) => Promise<unknown>,
      ) => {
        expect(permission).toBe("field-service:operate");
        return operation(
          {},
          { userId: "30000000-0000-4000-8000-000000000001" },
        );
      },
    );
  });

  it("deletes through the authenticated tenant-scoped repository", async () => {
    const request = new Request(
      `http://localhost/api/field-service/reports/${revisionId}`,
      { method: "DELETE" },
    );
    const response = await DELETE(request, {
      params: Promise.resolve({ id: revisionId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true, reportId });
    expect(state.assertMutation).toHaveBeenCalledWith(request);
    expect(state.deleteReport).toHaveBeenCalledWith(
      {},
      "30000000-0000-4000-8000-000000000001",
      revisionId,
      "delete-report-request",
    );
  });

  it("does not touch storage when mutation authentication fails", async () => {
    state.assertMutation.mockRejectedValueOnce(new Error("Forbidden"));
    const response = await DELETE(
      new Request(`http://localhost/api/field-service/reports/${revisionId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: revisionId }) },
    );

    expect(response.status).toBe(403);
    expect(state.tenant).not.toHaveBeenCalled();
    expect(state.deleteReport).not.toHaveBeenCalled();
  });
});
