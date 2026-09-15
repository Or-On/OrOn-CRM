import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  casePage: vi.fn(),
  contactPage: vi.fn(),
  permissions: [] as string[],
}));

vi.mock("@or-on/crm", () => ({
  createContact: vi.fn(),
  createServiceCase: vi.fn(),
  listContactPage: state.contactPage,
  listServiceCasePage: state.casePage,
  serviceCaseStatuses: [
    "awaiting_scheduling",
    "scheduled",
    "in_progress",
    "completed",
    "closed",
    "cancelled",
  ],
}));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: async (
    permission: string,
    operation: (sql: unknown, session: { userId: string }) => Promise<unknown>,
  ) => {
    state.permissions.push(permission);
    return operation({}, { userId: "90000000-0000-4000-8000-000000000001" });
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
  optionalText: (value: unknown) => value,
  text: (value: unknown) => value,
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

import { GET as contacts } from "../src/app/api/crm/contacts/route";
import { GET as serviceCases } from "../src/app/api/field-service/cases/route";

const cursorId = "10000000-0000-4000-8000-000000000001";
const cursorAt = "2026-09-15T12:00:00.000Z";

describe("stable server pagination APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions.length = 0;
    state.contactPage.mockResolvedValue({ contacts: [], nextCursor: null });
    state.casePage.mockResolvedValue({ cases: [], nextCursor: null });
  });

  it("passes search and the complete contact keyset cursor to the domain", async () => {
    const response = await contacts(
      new Request(
        `http://localhost/api/crm/contacts?q=fictional&limit=50&cursorAt=${encodeURIComponent(cursorAt)}&cursorId=${cursorId}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(state.permissions).toEqual(["crm:read"]);
    expect(state.contactPage).toHaveBeenCalledWith(
      {},
      {
        query: "fictional",
        limit: 50,
        cursor: { sortAt: cursorAt, id: cursorId },
      },
    );
  });

  it("rejects an incomplete or malformed contact cursor", async () => {
    expect(
      (
        await contacts(
          new Request(`http://localhost/api/crm/contacts?cursorAt=${cursorAt}`),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await contacts(
          new Request(
            "http://localhost/api/crm/contacts?cursorAt=invalid&cursorId=invalid",
          ),
        )
      ).status,
    ).toBe(400);
    expect(state.contactPage).not.toHaveBeenCalled();
  });

  it("passes status, search, and keyset cursor for service cases", async () => {
    const response = await serviceCases(
      new Request(
        `http://localhost/api/field-service/cases?status=scheduled&q=fixture&cursorAt=${encodeURIComponent(cursorAt)}&cursorId=${cursorId}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(state.permissions).toEqual(["field-service:read"]);
    expect(state.casePage).toHaveBeenCalledWith(
      {},
      {
        status: "scheduled",
        query: "fixture",
        limit: 50,
        cursor: { updatedAt: cursorAt, id: cursorId },
      },
    );
  });
});
