import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AutomaticCallProviderError,
  DispatcherAutomaticCallProvider,
} from "./call-provider.js";

afterEach(() => vi.unstubAllGlobals());

const request = {
  actorRole: "agent" as const,
  actorUserId: "20000000-0000-4000-8000-000000000001",
  contactId: "60000000-0000-4000-8000-000000000001",
  conversationContext: "Customer: Please call me.",
  conversationId: "30000000-0000-4000-8000-000000000001",
  destination: "+12025550198",
  flowId: "40000000-0000-4000-8000-000000000001",
  idempotencyKey: "whatsapp-auto-call:test",
  jobId: "50000000-0000-4000-8000-000000000001",
  tenantId: "10000000-0000-4000-8000-000000000001",
};

function provider(enabled = true): DispatcherAutomaticCallProvider {
  return new DispatcherAutomaticCallProvider({
    dispatcherUrl: "http://dispatcher.test:8082",
    enabled,
    serviceSecret: "a-fictional-service-secret-at-least-32-bytes",
    timeoutMs: 100,
  });
}

describe("DispatcherAutomaticCallProvider", () => {
  it("refuses before the network boundary when disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider(false).place(request)).rejects.toMatchObject({
      code: "automatic_calls_disabled",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the dispatcher contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        created: true,
        room: "call-fixture",
        session_id: "60000000-0000-4000-8000-000000000001",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(provider().place(request)).resolves.toEqual({
      created: true,
      sessionId: "60000000-0000-4000-8000-000000000001",
    });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(typeof init.body).toBe("string");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      caller_gender: null,
      conversation_context: request.conversationContext,
      explicit_approval: true,
      flow_id: request.flowId,
      phone_number: request.destination,
      source_conversation_id: request.conversationId,
    });
  });

  it.each([
    [400, false],
    [401, false],
    [403, false],
    [429, true],
    [503, true],
  ])("classifies dispatcher HTTP %i", async (status, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status })),
    );
    const error = await provider()
      .place(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AutomaticCallProviderError);
    expect(error).toMatchObject({
      code: `call_http_${String(status)}`,
      retryable,
    });
  });

  it("carries the authorized exact agent and retained flow version in the dispatcher contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        created: true,
        session_id: "60000000-0000-4000-8000-000000000001",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const agentVersionId = "70000000-0000-4000-8000-000000000001";
    await provider().place({ ...request, agentVersionId, flowVersion: 3 });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      agent_version_id: agentVersionId,
      flow_version: 3,
      flow_id: request.flowId,
    });
  });

  it.each([
    { agentVersionId: "forged-agent" },
    { flowVersion: 0 },
    { flowVersion: 1.5 },
  ])(
    "refuses malformed optional call binding %j before HTTP",
    async (binding) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        provider().place({ ...request, ...binding }),
      ).rejects.toMatchObject({
        code: "call_binding_invalid",
        retryable: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
