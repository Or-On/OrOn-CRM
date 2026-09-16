import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assertMutation: vi.fn(),
  deletePrivateObject: vi.fn(),
  deleteConversation: vi.fn(),
  permission: vi.fn(),
}));

vi.mock("@or-on/crm", () => ({
  assignConversation: vi.fn(),
  deleteConversation: state.deleteConversation,
  setConversationOwnership: vi.fn(),
  setConversationStatus: vi.fn(),
}));
vi.mock("@or-on/config", () => ({ loadConfig: vi.fn() }));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: (
    permission: string,
    operation: (...args: unknown[]) => unknown,
  ) => {
    state.permission(permission);
    return operation({}, { userId: "20000000-0000-4000-8000-000000000001" });
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
vi.mock("../src/features/private-objects", () => ({
  deletePrivateObject: state.deletePrivateObject,
}));

import { DELETE } from "../src/app/api/messaging/conversations/[id]/route";

const conversationId = "30000000-0000-4000-8000-000000000001";
const context = {
  params: Promise.resolve({ id: conversationId }),
} as Parameters<typeof DELETE>[1];

describe("conversation deletion API", () => {
  beforeEach(() => {
    state.assertMutation.mockReset().mockResolvedValue(undefined);
    state.deletePrivateObject.mockReset().mockResolvedValue(undefined);
    state.deleteConversation.mockReset().mockResolvedValue({
      status: "deleted",
      privateObjects: [],
    });
    state.permission.mockClear();
  });

  it("deletes through the authenticated tenant boundary", async () => {
    const response = await DELETE(
      new Request(
        `http://localhost/api/messaging/conversations/${conversationId}`,
        {
          method: "DELETE",
        },
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      retainedAsEvidence: false,
      storageCleanupPending: 0,
    });
    expect(state.assertMutation).toHaveBeenCalledOnce();
    expect(state.permission).toHaveBeenCalledWith("messaging:operate");
    expect(state.deleteConversation).toHaveBeenCalledWith(
      {},
      conversationId,
      "20000000-0000-4000-8000-000000000001",
    );
  });

  it.each([
    ["not_found", 404],
    ["active_work", 409],
  ] as const)("maps %s without hiding the result", async (result, status) => {
    state.deleteConversation.mockResolvedValue({ status: result });
    const response = await DELETE(
      new Request(
        `http://localhost/api/messaging/conversations/${conversationId}`,
        {
          method: "DELETE",
        },
      ),
      context,
    );
    expect(response.status).toBe(status);
    expect((await response.json()) as { error: string }).toHaveProperty(
      "error",
    );
  });

  it("removes protected technician evidence from the Inbox without deleting it", async () => {
    state.deleteConversation.mockResolvedValue({
      status: "removed_retained_evidence",
    });
    const response = await DELETE(
      new Request(
        `http://localhost/api/messaging/conversations/${conversationId}`,
        { method: "DELETE" },
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      retainedAsEvidence: true,
      storageCleanupPending: 0,
    });
    expect(state.deletePrivateObject).not.toHaveBeenCalled();
  });

  it("removes committed local files after the tenant transaction and reports deferred cleanup", async () => {
    state.deleteConversation.mockResolvedValue({
      status: "deleted",
      privateObjects: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          storageBackend: "local",
          storageKey: "tenant/messaging/conversation/media/file.jpg",
        },
        {
          id: "40000000-0000-4000-8000-000000000002",
          storageBackend: "gcs",
          storageKey: "tenant/messaging/conversation/media/file.pdf",
        },
      ],
    });

    const response = await DELETE(
      new Request(
        `http://localhost/api/messaging/conversations/${conversationId}`,
        { method: "DELETE" },
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(state.deletePrivateObject).toHaveBeenCalledWith(
      "tenant/messaging/conversation/media/file.jpg",
    );
    expect(await response.json()).toEqual({
      ok: true,
      retainedAsEvidence: false,
      storageCleanupPending: 1,
    });
  });

  it("keeps a successful deletion successful when physical cleanup is deferred", async () => {
    state.deleteConversation.mockResolvedValue({
      status: "deleted",
      privateObjects: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          storageBackend: "local",
          storageKey: "tenant/messaging/conversation/media/file.jpg",
        },
      ],
    });
    state.deletePrivateObject.mockRejectedValue(new Error("disk unavailable"));

    const response = await DELETE(
      new Request(
        `http://localhost/api/messaging/conversations/${conversationId}`,
        { method: "DELETE" },
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      retainedAsEvidence: false,
      storageCleanupPending: 1,
    });
  });

  it("does not reach PostgreSQL when mutation authentication fails", async () => {
    state.assertMutation.mockRejectedValue(new Error("CSRF rejected"));
    const response = await DELETE(
      new Request(
        `http://localhost/api/messaging/conversations/${conversationId}`,
        {
          method: "DELETE",
        },
      ),
      context,
    );
    expect(response.status).toBe(400);
    expect(state.deleteConversation).not.toHaveBeenCalled();
  });
});
