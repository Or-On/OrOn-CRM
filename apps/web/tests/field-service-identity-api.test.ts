import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  identify: vi.fn(),
  freshTenant: vi.fn(),
}));

vi.mock("@or-on/crm", () => ({
  identifyTechnicianSession: state.identify,
}));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  requestId: () => "identity-request",
  withFreshCurrentTenant: state.freshTenant,
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: vi.fn(),
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    ),
}));
vi.mock("../src/features/field-service", () => ({
  optionalText: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined,
  text: (value: unknown) => String(value).trim(),
  uuid: (value: unknown) => String(value),
}));

import { POST } from "../src/app/api/field-service/visits/[id]/identity/route";

describe("field-service technician identity API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.identify.mockResolvedValue("30000000-0000-4000-8000-000000000001");
    state.freshTenant.mockImplementation(
      async (
        permission: string,
        operation: (
          sql: unknown,
          session: {
            sessionId: string;
            absoluteExpiresAt: Date;
          },
        ) => Promise<unknown>,
      ) => {
        expect(permission).toBe("field-service:operate");
        return operation(
          {},
          {
            sessionId: "40000000-0000-4000-8000-000000000001",
            absoluteExpiresAt: new Date("2026-09-16T12:00:00.000Z"),
          },
        );
      },
    );
  });

  it("uses fresh technician authorization without forwarding browser session metadata", async () => {
    const response = await POST(
      new Request(
        "http://localhost/api/field-service/visits/10000000-0000-4000-8000-000000000001/identity",
        {
          method: "POST",
          body: JSON.stringify({
            technicianId: "20000000-0000-4000-8000-000000000001",
            fullName: "Synthetic Technician",
            employeeIdentifier: "TECH-QA",
          }),
        },
      ),
      {
        params: Promise.resolve({
          id: "10000000-0000-4000-8000-000000000001",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(state.freshTenant).toHaveBeenCalledOnce();
    expect(state.identify).toHaveBeenCalledWith(
      {},
      {
        visitId: "10000000-0000-4000-8000-000000000001",
        technicianId: "20000000-0000-4000-8000-000000000001",
        fullName: "Synthetic Technician",
        employeeIdentifier: "TECH-QA",
        requestId: "identity-request",
      },
    );
  });

  it("does not reach the repository when fresh authorization is rejected", async () => {
    state.freshTenant.mockRejectedValueOnce(new Error("Forbidden"));

    const response = await POST(
      new Request(
        "http://localhost/api/field-service/visits/10000000-0000-4000-8000-000000000001/identity",
        {
          method: "POST",
          body: JSON.stringify({
            technicianId: "20000000-0000-4000-8000-000000000001",
            fullName: "Synthetic Technician",
          }),
        },
      ),
      {
        params: Promise.resolve({
          id: "10000000-0000-4000-8000-000000000001",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(state.identify).not.toHaveBeenCalled();
  });
});
