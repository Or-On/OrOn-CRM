import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assertAuthenticatedMutation: vi.fn(),
  loadConfig: vi.fn(),
  setConversationOwnership: vi.fn(),
  permission: vi.fn(),
}));

vi.mock("@or-on/crm", () => ({
  assignConversation: vi.fn(),
  deleteConversation: vi.fn(),
  markConversationRead: vi.fn(),
  setConversationOwnership: state.setConversationOwnership,
  setConversationStatus: vi.fn(),
}));
vi.mock("@or-on/config", () => ({ loadConfig: state.loadConfig }));
// The real CRM error mapping stays under test: the Inbox translates these exact
// messages, so a silent change to either side must fail here.
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: state.assertAuthenticatedMutation,
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: (
    permission: string,
    operation: (...args: unknown[]) => unknown,
  ) => {
    state.permission(permission);
    return operation({}, { userId: "20000000-0000-4000-8000-000000000001" });
  },
}));
vi.mock("../src/features/private-objects", () => ({
  deletePrivateObject: vi.fn(),
}));

import { PATCH } from "../src/app/api/messaging/conversations/[id]/route";

const conversationId = "30000000-0000-4000-8000-000000000001";
const publishedVersionId = "00000000-0000-4000-8000-000000000091";
const context = {
  params: Promise.resolve({ id: conversationId }),
} as Parameters<typeof PATCH>[1];

function patch(body: Record<string, unknown>) {
  return PATCH(
    new Request(
      `http://localhost/api/messaging/conversations/${conversationId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
    context,
  );
}

describe("conversation responder API", () => {
  beforeEach(() => {
    state.assertAuthenticatedMutation.mockReset().mockResolvedValue(undefined);
    state.loadConfig.mockReset().mockReturnValue({ enableWhatsAppAi: true });
    state.setConversationOwnership.mockReset().mockResolvedValue(true);
    state.permission.mockClear();
  });

  it("hands the conversation to the agent version the operator chose", async () => {
    const response = await patch({
      ownershipMode: "ai",
      agentProfileVersionId: publishedVersionId,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.permission).toHaveBeenCalledWith("messaging:operate");
    expect(state.setConversationOwnership).toHaveBeenCalledWith(
      {},
      conversationId,
      "20000000-0000-4000-8000-000000000001",
      "ai",
      publishedVersionId,
      undefined,
    );
  });

  it("names the disabled deployment flag instead of failing anonymously", async () => {
    state.loadConfig.mockReturnValue({ enableWhatsAppAi: false });

    const response = await patch({
      ownershipMode: "ai",
      agentProfileVersionId: publishedVersionId,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "WhatsApp AI is disabled by the platform operator",
    });
    expect(state.setConversationOwnership).not.toHaveBeenCalled();
  });

  it("names the missing published agent when no version is supplied", async () => {
    const response = await patch({ ownershipMode: "ai" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "a published WhatsApp agent is required",
    });
    expect(state.setConversationOwnership).not.toHaveBeenCalled();
  });

  it("reports a conversation that no longer accepts the change as missing", async () => {
    state.setConversationOwnership.mockResolvedValue(false);

    const response = await patch({
      ownershipMode: "ai",
      agentProfileVersionId: publishedVersionId,
    });

    expect(response.status).toBe(404);
  });

  it("carries the human takeover reason through unchanged", async () => {
    const response = await patch({
      ownershipMode: "human",
      reason: "Human takeover requested from Inbox",
    });

    expect(response.status).toBe(200);
    expect(state.setConversationOwnership).toHaveBeenCalledWith(
      {},
      conversationId,
      "20000000-0000-4000-8000-000000000001",
      "human",
      undefined,
      "Human takeover requested from Inbox",
    );
  });
});
