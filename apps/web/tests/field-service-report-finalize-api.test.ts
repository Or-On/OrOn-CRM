import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  finalize: vi.fn(),
  tenant: vi.fn(),
}));

vi.mock("@or-on/crm", () => ({
  finalizeReportRevision: state.finalize,
}));
vi.mock("../src/features/auth", () => ({
  requestId: () => "finalize-request",
  withCurrentTenant: state.tenant,
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: vi.fn(),
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 403 },
    ),
}));
vi.mock("../src/features/field-service", () => ({
  uuid: (value: unknown) => String(value),
}));

import { POST } from "../src/app/api/field-service/reports/[id]/finalize/route";

const revisionId = "10000000-0000-4000-8000-000000000001";

describe("field-service report finalization API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.finalize.mockResolvedValue({ id: revisionId, status: "finalized" });
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
          { userId: "20000000-0000-4000-8000-000000000001" },
        );
      },
    );
  });

  it("lets an authorized tenant actor finalize through the scoped repository", async () => {
    const response = await POST(
      new Request(
        `http://localhost/api/field-service/reports/${revisionId}/finalize`,
        {
          method: "POST",
        },
      ),
      { params: Promise.resolve({ id: revisionId }) },
    );

    expect(response.status).toBe(200);
    expect(state.tenant).toHaveBeenCalledOnce();
    expect(state.finalize).toHaveBeenCalledWith(
      {},
      "20000000-0000-4000-8000-000000000001",
      revisionId,
      "finalize-request",
    );
  });

  it("does not reach report storage after tenant authorization is rejected", async () => {
    state.tenant.mockRejectedValueOnce(new Error("Forbidden"));

    const response = await POST(
      new Request(
        `http://localhost/api/field-service/reports/${revisionId}/finalize`,
        {
          method: "POST",
        },
      ),
      { params: Promise.resolve({ id: revisionId }) },
    );

    expect(response.status).toBe(403);
    expect(state.finalize).not.toHaveBeenCalled();
  });
});
