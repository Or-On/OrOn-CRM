import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  list: vi.fn(),
  parseCursor: vi.fn(),
  permissions: [] as string[],
}));

vi.mock("@or-on/crm", () => ({
  listConversationPage: state.list,
  parseConversationCursor: state.parseCursor,
}));
vi.mock("../src/features/auth", () => ({
  withCurrentTenant: async (
    permission: string,
    operation: (sql: unknown, session: { userId: string }) => unknown,
  ) => {
    state.permissions.push(permission);
    const result = await operation(
      {},
      { userId: "20000000-0000-4000-8000-000000000001" },
    );
    return result;
  },
}));
vi.mock("../src/features/crm-route", () => ({
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    ),
}));

import { GET } from "../src/app/api/messaging/conversations/route";

describe("conversation list API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions.length = 0;
    state.list.mockResolvedValue({ conversations: [], nextCursor: null });
    state.parseCursor.mockImplementation(
      (before: string | null, id: string | null) => {
        if (before === null && id === null) return undefined;
        if (before === null || id === null)
          throw new TypeError("Invalid conversation cursor");
        return { lastMessageAt: before, id };
      },
    );
  });

  it("binds server search, filters, and cursors to the current tenant user", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/messaging/conversations?q=Fictional%20Customer&filter=mine&channel=whatsapp&before=2026-09-15T10%3A00%3A00.123456Z&beforeId=30000000-0000-4000-8000-000000000001",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversations: [],
      nextCursor: null,
    });
    expect(state.permissions).toEqual(["crm:read"]);
    expect(state.list).toHaveBeenCalledWith(
      {},
      {
        query: "Fictional Customer",
        filter: "mine",
        currentUserId: "20000000-0000-4000-8000-000000000001",
        channelKind: "whatsapp",
        before: {
          lastMessageAt: "2026-09-15T10:00:00.123456Z",
          id: "30000000-0000-4000-8000-000000000001",
        },
      },
    );
  });

  it("rejects invalid filters and partial cursors before querying", async () => {
    const invalidFilter = await GET(
      new Request(
        "http://localhost/api/messaging/conversations?filter=not-a-filter",
      ),
    );
    expect(invalidFilter.status).toBe(400);
    expect(state.list).not.toHaveBeenCalled();
    expect(state.permissions).toEqual([]);

    const partialCursor = await GET(
      new Request(
        "http://localhost/api/messaging/conversations?before=2026-09-15T10%3A00%3A00.123456Z",
      ),
    );
    expect(partialCursor.status).toBe(400);
    expect(state.list).not.toHaveBeenCalled();
  });

  it("keeps the id lookup response shape backward compatible", async () => {
    const id = "30000000-0000-4000-8000-000000000001";
    await GET(
      new Request(`http://localhost/api/messaging/conversations?id=${id}`),
    );

    expect(state.list).toHaveBeenCalledWith(
      {},
      {
        conversationId: id,
        currentUserId: "20000000-0000-4000-8000-000000000001",
      },
    );
  });
});
