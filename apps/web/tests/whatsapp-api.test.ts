import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: false,
  acceptWebhook: vi.fn(),
  queue: vi.fn(),
  page: vi.fn(),
  permission: vi.fn(),
  channelPhone: "1312069101984418",
}));

vi.mock("@or-on/crm", () => ({
  acceptWhatsAppWebhook: state.acceptWebhook,
  InvalidWhatsAppPayloadError: class InvalidWhatsAppPayloadError extends Error {},
  InvalidWhatsAppSignatureError: class InvalidWhatsAppSignatureError extends Error {},
  listMessagePage: state.page,
  parseMessageCursor: () => undefined,
  queueWhatsAppOutbound: state.queue,
}));
vi.mock("@or-on/config", () => ({
  loadWhatsAppMemoryVerifier: () => ({ enabled: false }),
  loadConfig: () => ({
    databaseUrl: "postgresql://fixture.invalid/fixture",
    enableRealWhatsApp: state.enabled,
    whatsApp: {
      graphApiVersion: "v26.0",
      phoneNumberId: "1312069101984418",
      wabaId: "1507601250680263",
    },
    whatsAppAdditionalAccounts: [
      {
        key: "second-account",
        phoneNumberId: "22990011",
        wabaId: "88110022",
        graphApiVersion: "v23.0",
        accessToken: "fixture-access-token",
        appSecret: "fictional-second-app-secret",
        webhookVerifyToken: "fictional-second-verify-token",
      },
    ],
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
  ) => {
    state.permission(_permission);
    return operation(
      () => Promise.resolve([{ provider_account_id: state.channelPhone }]),
      { userId: "20000000-0000-4000-8000-000000000001" },
    );
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: () => Promise.resolve(),
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    ),
}));

import {
  GET,
  POST,
} from "../src/app/api/messaging/conversations/[id]/messages/route";
import {
  GET as verifyWebhook,
  POST as acceptWebhook,
} from "../src/app/api/webhooks/whatsapp/route";
import {
  GET as verifyAdditionalWebhook,
  POST as acceptAdditionalWebhook,
} from "../src/app/api/webhooks/whatsapp/[accountKey]/route";

const context = {
  params: Promise.resolve({ id: "30000000-0000-4000-8000-000000000001" }),
} as Parameters<typeof POST>[1];

describe("WhatsApp outbound API", () => {
  beforeEach(() => {
    vi.stubEnv("PLATFORM_ENV", "development");
    state.enabled = false;
    state.channelPhone = "1312069101984418";
    state.acceptWebhook.mockReset().mockResolvedValue({ envelopes: 1 });
    state.page.mockReset();
    state.permission.mockClear();
    state.queue.mockReset().mockResolvedValue({
      conversationId: "conversation",
      messageId: "message",
      provider: "simulator",
      queued: true,
      requestId: "request",
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns projected diagnostics through the existing authenticated tenant read", async () => {
    const page = {
      messages: [
        {
          id: "fixture",
          deliveryFailure: { code: "meta_100", diagnostic: null },
        },
      ],
      nextCursor: null,
    };
    state.page.mockResolvedValue(page);
    const response = await GET(
      new Request("http://localhost/api/messages"),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(state.permission).toHaveBeenCalledWith("crm:read");
    expect(state.queue).not.toHaveBeenCalled();
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
    expect(state.queue.mock.calls[0]?.[2]).toEqual({
      graphApiVersion: "v26.0",
      phoneNumberId: "1312069101984418",
      wabaId: "1507601250680263",
    });
  });

  it("does not let request data override conversation-derived recipient routing", async () => {
    state.enabled = true;
    await POST(
      new Request("http://localhost/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "api-routing-12345",
        },
        body: JSON.stringify({
          provider: "meta",
          kind: "text",
          text: "Confirmed",
          confirmReal: true,
          recipientIdentityId: "90000000-0000-4000-8000-000000000009",
          recipientAddress: "+12025550199",
        }),
      }),
      context,
    );

    expect(state.queue.mock.calls[0]?.[1]).not.toHaveProperty(
      "recipientIdentityId",
    );
    expect(state.queue.mock.calls[0]?.[1]).not.toHaveProperty(
      "recipientAddress",
    );
  });

  it("routes a real message through its bound additional account", async () => {
    state.enabled = true;
    state.channelPhone = "22990011";
    const response = await POST(
      new Request("http://localhost/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "meta",
          text: "Confirmed",
          confirmReal: true,
        }),
      }),
      context,
    );
    expect(response.status).toBe(202);
    expect(state.queue.mock.calls[0]?.[2]).toEqual({
      graphApiVersion: "v23.0",
      phoneNumberId: "22990011",
      wabaId: "88110022",
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

  it("rejects oversized webhook bodies before persistence", async () => {
    state.enabled = true;
    const response = await acceptWebhook(
      new Request("http://localhost/api/webhooks/whatsapp", {
        method: "POST",
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    expect(state.acceptWebhook).not.toHaveBeenCalled();
  });

  it("uses a separate verify token and app secret for an additional webhook", async () => {
    state.enabled = true;
    const additionalContext = {
      params: Promise.resolve({ accountKey: "second-account" }),
    } as Parameters<typeof acceptAdditionalWebhook>[1];
    const challenge = await verifyAdditionalWebhook(
      new Request(
        "http://localhost/api/webhooks/whatsapp/second-account?hub.mode=subscribe&hub.verify_token=fictional-second-verify-token&hub.challenge=ready",
      ),
      additionalContext,
    );
    expect(challenge.status).toBe(200);
    expect(await challenge.text()).toBe("ready");
    const accepted = await acceptAdditionalWebhook(
      new Request("http://localhost/api/webhooks/whatsapp/second-account", {
        method: "POST",
        body: "{}",
      }),
      additionalContext,
    );
    expect(accepted.status).toBe(200);
    expect(state.acceptWebhook.mock.calls[0]?.[3]).toBe(
      "fictional-second-app-secret",
    );
    expect(state.acceptWebhook.mock.calls[0]?.[4]).toBe("22990011");
  });
});
