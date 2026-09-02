import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: false,
  queue: vi.fn(),
}));

vi.mock("@or-on/crm", () => ({
  listMessages: vi.fn(() => Promise.resolve([])),
  queueWhatsAppOutbound: state.queue,
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({
    enableRealWhatsApp: state.enabled,
    whatsApp: {
      graphApiVersion: "v26.0",
      phoneNumberId: "1312069101984418",
      wabaId: "1507601250680263",
    },
    secrets: {
      whatsappAppSecret: "fictional-app-secret",
      whatsappWebhookVerifyToken: "fictional-verify-token",
    },
  }),
}));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: (
    _permission: string,
    operation: (...args: unknown[]) => unknown,
  ) => operation({}, { userId: "20000000-0000-4000-8000-000000000001" }),
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: () => Promise.resolve(),
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    ),
}));

import { POST } from "../src/app/api/messaging/conversations/[id]/messages/route";
import { GET as verifyWebhook } from "../src/app/api/webhooks/whatsapp/route";

const context = {
  params: Promise.resolve({ id: "30000000-0000-4000-8000-000000000001" }),
} as Parameters<typeof POST>[1];

describe("WhatsApp outbound API", () => {
  beforeEach(() => {
    state.enabled = false;
    state.queue.mockReset().mockResolvedValue({
      conversationId: "conversation",
      messageId: "message",
      provider: "simulator",
      queued: true,
      requestId: "request",
    });
  });

  it("defaults admission to the simulator", async () => {
    const response = await POST(
      new Request("http://localhost/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-request-123",
        },
        body: JSON.stringify({ text: "Safe local message" }),
      }),
      context,
    );
    expect(response.status).toBe(202);
    expect(state.queue.mock.calls[0]?.[1]).toMatchObject({
      provider: "simulator",
      realProviderEnabled: false,
      explicitlyConfirmed: false,
    });
  });

  it("passes real admission only with explicit confirmation and enabled config", async () => {
    state.enabled = true;
    await POST(
      new Request("http://localhost/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-real-12345",
        },
        body: JSON.stringify({
          provider: "meta",
          kind: "text",
          text: "Confirmed",
          confirmReal: true,
        }),
      }),
      context,
    );
    expect(state.queue.mock.calls[0]?.[1]).toMatchObject({
      provider: "meta",
      realProviderEnabled: true,
      explicitlyConfirmed: true,
    });
  });

  it("verifies Meta GET challenges only while explicitly enabled", () => {
    state.enabled = true;
    const response = verifyWebhook(
      new Request(
        "http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=fictional-verify-token&hub.challenge=challenge-123",
      ),
    );
    expect(response.status).toBe(200);
    state.enabled = false;
    expect(
      verifyWebhook(new Request("http://localhost/api/webhooks/whatsapp")),
    ).toMatchObject({ status: 404 });
  });
});
