import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  queue: vi.fn(),
  guard: vi.fn(),
  permission: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@or-on/crm", () => ({ queueCanonicalSimulation: state.queue }));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: (
    permission: string,
    operation: (sql: never, session: { userId: string }) => unknown,
  ) => {
    state.permission(permission);
    return operation({} as never, { userId: "fictional-user" });
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.guard,
  crmErrorResponse: () => Response.json({ error: "refused" }, { status: 400 }),
}));
import { POST } from "../src/app/api/orchestration/flows/[id]/simulate/route";
import { OrchestrationPanel } from "../src/features/orchestration";

describe("canonical simulator API and UI", () => {
  beforeEach(() => {
    state.queue.mockReset().mockResolvedValue("run-id");
    state.guard.mockReset().mockResolvedValue(undefined);
    state.permission.mockClear();
  });
  it("requires CSRF/auth guard, flow RBAC, explicit conversation and idempotency", async () => {
    const request = () =>
      new Request("http://localhost/api/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "fixture-key",
        },
        body: JSON.stringify({
          conversationId: "conversation",
          channel: "voice",
        }),
      });
    const response = await POST(request(), {
      params: Promise.resolve({ id: "flow" }),
    });
    expect(response.status).toBe(202);
    expect(state.permission).toHaveBeenCalledWith("flows:manage");
    expect(await response.json()).toEqual({
      runId: "run-id",
      mode: "simulator",
    });
    state.guard.mockRejectedValue(new Error("CSRF"));
    expect(
      (await POST(request(), { params: Promise.resolve({ id: "flow" }) }))
        .status,
    ).toBe(400);
    expect(state.queue).toHaveBeenCalledTimes(1);
  });
  it("rejects OpenLive and missing scope without queueing", async () => {
    const response = await POST(
      new Request("http://localhost/api/test", {
        method: "POST",
        body: JSON.stringify({ channel: "openlive" }),
      }),
      { params: Promise.resolve({ id: "flow" }) },
    );
    expect(response.status).toBe(400);
    expect(state.queue).not.toHaveBeenCalled();
  });
  it("renders explicitly labeled simulator controls and retained version fields", () => {
    const markup = renderToStaticMarkup(
      <OrchestrationPanel
        activity={[]}
        agents={[]}
        conversations={[]}
        handoffs={[]}
        voiceOutcomes={[]}
        flows={[
          {
            id: "fixture-flow",
            name: "Fixture flow",
            description: null,
            version: 1,
            published: true,
            validationStatus: "valid",
            createdAt: "2026-09-02",
          },
        ]}
        usage={{
          agentEvents: 0,
          inputTokens: 0,
          outputTokens: 0,
          averageLatencyMs: null,
          voiceSessions: 0,
          messagingJobs: 0,
          unpricedEvents: 0,
          estimatedCostUsd: null,
        }}
      />,
    );
    expect(markup).toContain("Queue flow simulation");
    expect(markup).toContain("Published voice flow version");
    expect(markup).toContain("Local simulation only");
  });
});
