import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  list: vi.fn(),
  permissions: [] as string[],
}));

vi.mock("@or-on/crm", () => ({
  listServiceReportPage: state.list,
  openReportDraft: vi.fn(),
  serviceReportStatuses: [
    "draft",
    "review_required",
    "finalized",
    "superseded",
  ],
}));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: (
    permission: string,
    operation: (sql: unknown) => unknown,
  ) => {
    state.permissions.push(permission);
    return operation({});
  },
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
  uuid: (value: unknown) => {
    if (
      typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      )
    )
      throw new TypeError("invalid UUID");
    return value;
  },
}));

import { GET } from "../src/app/api/field-service/reports/route";

const cursorId = "10000000-0000-4000-8000-000000000001";
const cursorAt = "2026-09-15T12:00:00.000Z";

describe("field-service report history API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions.length = 0;
    state.list.mockResolvedValue({ reports: [], nextCursor: null });
  });

  it("passes tenant-read filters and a complete keyset cursor", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/field-service/reports?status=finalized&q=fixture&limit=25&cursorAt=${encodeURIComponent(cursorAt)}&cursorId=${cursorId}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(state.permissions).toEqual(["field-service:read"]);
    expect(state.list).toHaveBeenCalledWith(
      {},
      {
        status: "finalized",
        query: "fixture",
        limit: 25,
        cursor: { updatedAt: cursorAt, id: cursorId },
      },
    );
  });

  it("rejects invalid filters and incomplete cursors before tenant access", async () => {
    for (const query of [
      "status=unknown",
      `cursorAt=${encodeURIComponent(cursorAt)}`,
      "cursorAt=invalid&cursorId=invalid",
      `cursorAt=${encodeURIComponent(cursorAt)}&cursorId=invalid`,
      "limit=0",
    ]) {
      const response = await GET(
        new Request(`http://localhost/api/field-service/reports?${query}`),
      );
      expect(response.status).toBe(400);
    }
    expect(state.list).not.toHaveBeenCalled();
    expect(state.permissions).toEqual([]);
  });
});
