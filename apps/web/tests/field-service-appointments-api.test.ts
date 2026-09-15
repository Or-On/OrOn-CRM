import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assertMutation: vi.fn(),
  schedule: vi.fn(),
  suggest: vi.fn(),
}));

vi.mock("@or-on/crm", () => ({
  listServiceAppointments: vi.fn(),
  scheduleServiceAppointment: state.schedule,
  suggestNextServiceAppointment: state.suggest,
}));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  requestId: () => "generated-request-id",
  withCurrentTenant: (
    permission: string,
    operation: (sql: unknown, session: { readonly userId: string }) => unknown,
  ) => {
    expect(permission).toBe("field-service:operate");
    return operation({}, { userId: "90000000-0000-4000-8000-000000000001" });
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.assertMutation,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    ),
}));

import { POST } from "../src/app/api/field-service/appointments/route";

const caseId = "10000000-0000-4000-8000-000000000001";
const technicianId = "20000000-0000-4000-8000-000000000001";

function request(body: Readonly<Record<string, unknown>>) {
  return new Request("http://localhost/api/field-service/appointments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "field-schedule-request-1",
    },
    body: JSON.stringify(body),
  });
}

describe("field-service appointment API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.assertMutation.mockResolvedValue(undefined);
    state.schedule.mockResolvedValue({ id: "manual" });
    state.suggest.mockResolvedValue({ id: "suggested" });
  });

  it("routes a calendar-grounded suggestion through the dedicated contract", async () => {
    const response = await POST(
      request({
        action: "suggest",
        caseId,
        durationMinutes: 60,
        earliestAt: "2026-10-01T08:00:00.000Z",
        timezone: "Asia/Jerusalem",
        notes: "Synthetic scheduling request",
      }),
    );

    expect(response.status).toBe(201);
    expect(state.suggest).toHaveBeenCalledWith(
      {},
      "90000000-0000-4000-8000-000000000001",
      {
        caseId,
        durationMinutes: 60,
        earliestAt: "2026-10-01T08:00:00.000Z",
        timezone: "Asia/Jerusalem",
        notes: "Synthetic scheduling request",
        idempotencyKey: "field-schedule-request-1",
      },
    );
    expect(state.schedule).not.toHaveBeenCalled();
  });

  it("does not let a caller disguise manual scheduling as pre-approved AI work", async () => {
    const response = await POST(
      request({
        action: "schedule",
        caseId,
        technicianId,
        startsAt: "2026-10-01T08:00:00.000Z",
        endsAt: "2026-10-01T09:00:00.000Z",
        timezone: "UTC",
        source: "ai_suggestion",
        approveSuggestion: true,
      }),
    );

    expect(response.status).toBe(201);
    expect(state.schedule).toHaveBeenCalledWith(
      {},
      "90000000-0000-4000-8000-000000000001",
      {
        caseId,
        technicianId,
        startsAt: "2026-10-01T08:00:00.000Z",
        endsAt: "2026-10-01T09:00:00.000Z",
        timezone: "UTC",
        source: "manual",
        idempotencyKey: "field-schedule-request-1",
      },
    );
    expect(state.suggest).not.toHaveBeenCalled();
  });

  it("rejects unknown scheduling actions before either mutation runs", async () => {
    const response = await POST(request({ action: "book_without_approval" }));

    expect(response.status).toBe(400);
    expect(state.schedule).not.toHaveBeenCalled();
    expect(state.suggest).not.toHaveBeenCalled();
  });
});
