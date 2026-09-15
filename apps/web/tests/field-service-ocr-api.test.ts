import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  list: vi.fn(),
  permissions: [] as string[],
}));

vi.mock("@or-on/crm", () => ({
  listServiceOcrQueuePage: state.list,
  serviceOcrQueueViews: ["attention", "in_flight", "completed", "all"],
  serviceOcrStatuses: [
    "pending",
    "processing",
    "review_required",
    "confirmed",
    "failed",
  ],
}));
vi.mock("../src/features/auth", () => ({
  withCurrentTenant: (
    permission: string,
    operation: (sql: unknown) => unknown,
  ) => {
    state.permissions.push(permission);
    return operation({});
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

import { GET } from "../src/app/api/field-service/ocr/route";

const cursorId = "10000000-0000-4000-8000-000000000001";
const cursorAt = "2026-09-15T12:00:00.000Z";

describe("field-service OCR queue API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions.length = 0;
    state.list.mockResolvedValue({
      items: [],
      counts: { all: 0, attention: 0, inFlight: 0, completed: 0 },
      nextCursor: null,
    });
  });

  it("passes tenant-read search, view, and a complete keyset cursor", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/field-service/ocr?view=completed&q=fixture&limit=25&cursorStatus=confirmed&cursorAt=${encodeURIComponent(cursorAt)}&cursorId=${cursorId}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(state.permissions).toEqual(["field-service:read"]);
    expect(state.list).toHaveBeenCalledWith(
      {},
      {
        view: "completed",
        query: "fixture",
        limit: 25,
        cursor: { status: "confirmed", createdAt: cursorAt, id: cursorId },
      },
    );
  });

  it("rejects invalid views and incomplete cursors before tenant access", async () => {
    for (const query of [
      "view=unknown",
      `cursorAt=${encodeURIComponent(cursorAt)}`,
      `cursorAt=${encodeURIComponent(cursorAt)}&cursorId=${cursorId}`,
      `cursorStatus=unknown&cursorAt=${encodeURIComponent(cursorAt)}&cursorId=${cursorId}`,
      `cursorStatus=confirmed&cursorAt=invalid&cursorId=${cursorId}`,
      `cursorStatus=confirmed&cursorAt=${encodeURIComponent(cursorAt)}&cursorId=invalid`,
      "limit=0",
      "limit=501",
      `q=${"x".repeat(501)}`,
    ]) {
      const response = await GET(
        new Request(`http://localhost/api/field-service/ocr?${query}`),
      );
      expect(response.status).toBe(400);
    }
    expect(state.list).not.toHaveBeenCalled();
    expect(state.permissions).toEqual([]);
  });
});
