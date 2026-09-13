import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getContact: vi.fn(),
  issueDispatcherGrant: vi.fn(),
}));

vi.mock("@or-on/crm", () => ({ getContact: dependencies.getContact }));
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: vi.fn().mockResolvedValue({
    tenant: { role: "owner", tenantId: "tenant-id" },
    userId: "user-id",
  }),
  ForbiddenError: class ForbiddenError extends Error {},
  issueDispatcherGrant: dependencies.issueDispatcherGrant,
  jsonObject: (request: Request) => request.json(),
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  withCurrentTenant: async (
    _permission: string,
    operation: (sql: unknown) => Promise<unknown>,
  ) => operation(vi.fn().mockResolvedValue([{ found: true }])),
}));

import { POST } from "../src/app/api/voice/real-calls/route";

function request(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/voice/real-calls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contactId: "30000000-0000-4000-8000-000000000001",
      callerGender: "male",
      explicitApproval: true,
      flowId: "702a2dd8-24d9-4d54-a571-89c69978d48a",
      idempotencyKey: "real-call:fixture",
      ...overrides,
    }),
  });
}

describe("real call admission boundary", () => {
  beforeEach(() => {
    process.env.ENABLE_REAL_TELEPHONY = "true";
    process.env.ENABLE_REAL_VOICE_PROVIDERS = "true";
    dependencies.getContact.mockResolvedValue({
      identities: [
        {
          channel: "phone",
          normalizedValue: "+14155550123",
          validationStatus: "valid",
        },
      ],
      lifecycleStatus: "active",
      voiceConsent: "granted",
    });
    dependencies.issueDispatcherGrant.mockResolvedValue("signed-assertion");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.DISPATCHER_URL;
    delete process.env.ENABLE_REAL_TELEPHONY;
    delete process.env.ENABLE_REAL_VOICE_PROVIDERS;
  });

  it("refuses before touching the dispatcher when either kill switch is off", async () => {
    process.env.ENABLE_REAL_TELEPHONY = "false";
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires explicit per-call approval", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(request({ explicitApproval: false }));
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards a validated call only after the database transaction returns", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json(
        {
          created: true,
          room: "call-fixture",
          session_id: "40000000-0000-4000-8000-000000000001",
        },
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer signed-assertion",
    );
    if (typeof init.body !== "string") throw new Error("expected JSON body");
    expect(JSON.parse(init.body)).toMatchObject({
      explicit_approval: true,
      caller_gender: "male",
      flow_id: "702a2dd8-24d9-4d54-a571-89c69978d48a",
      phone_number: "+14155550123",
    });
  });

  it("requires a supported caller address form before contacting the dispatcher", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(request({ callerGender: "unknown" }));

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows the dispatcher's sanitized model preflight failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { detail: "LLM provider billing or quota is unavailable" },
            { status: 503 },
          ),
        ),
    );

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "LLM provider billing or quota is unavailable",
    });
  });
});
