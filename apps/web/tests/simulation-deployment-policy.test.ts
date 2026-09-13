import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ mutate: vi.fn(), tenant: vi.fn() }));
vi.mock("@or-on/crm", () => ({
  createSimulatorBroadcast: dependencies.mutate,
  listBroadcasts: vi.fn(),
  enqueueSimulatorBroadcast: dependencies.mutate,
  queueCallOutcomeWhatsAppFollowup: dependencies.mutate,
  queueWhatsAppTriggeredCall: dependencies.mutate,
  queueCanonicalSimulation: dependencies.mutate,
  runManualAutomation: dependencies.mutate,
  ingestSimulatedInbound: dependencies.mutate,
  queueWhatsAppOutbound: dependencies.mutate,
  listMessagePage: vi.fn(),
  parseMessageCursor: vi.fn(),
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({
    enableRealWhatsApp: true,
    whatsApp: {
      graphApiVersion: "v26.0",
      phoneNumberId: "fictional",
      wabaId: "fictional",
    },
  }),
}));
vi.mock("@or-on/api-client", () => ({ ControlApiClient: vi.fn() }));
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: () => Promise.resolve({}),
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  issueControlApiGrant: vi.fn(),
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: dependencies.tenant,
}));

import { POST as createCampaign } from "../src/app/api/campaigns/route";
import { POST as deliverCampaign } from "../src/app/api/campaigns/[id]/deliver/route";
import { POST as simulateOrchestration } from "../src/app/api/orchestration/simulate/route";
import { POST as simulateFlow } from "../src/app/api/orchestration/flows/[id]/simulate/route";
import { POST as runEmptyAutomation } from "../src/app/api/automations/[id]/run/route";
import { POST as simulateInbound } from "../src/app/api/messaging/simulate/inbound/route";
import { POST as simulateCall } from "../src/app/api/voice/simulated-calls/route";
import { POST as outbound } from "../src/app/api/messaging/conversations/[id]/messages/route";
import { simulationRefusal } from "../src/features/simulation-policy";

const context = {
  params: Promise.resolve({ id: "30000000-0000-4000-8000-000000000001" }),
};
const request = (body: Record<string, unknown> = {}) =>
  new Request("http://localhost/api/fictional", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "fictional-key",
    },
    body: JSON.stringify(body),
  });
const simulators = [
  ["campaign creation", () => createCampaign(request())],
  ["campaign delivery", () => deliverCampaign(request(), context)],
  ["cross-channel simulation", () => simulateOrchestration(request())],
  ["canonical flow simulation", () => simulateFlow(request(), context)],
  ["empty automation run", () => runEmptyAutomation(request(), context)],
  ["fictional inbound", () => simulateInbound(request())],
  ["fictional call", () => simulateCall(request())],
  ["implicit simulator outbound", () => outbound(request(), context)],
] as const;

describe("simulation is not a staging/production success path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.mutate.mockResolvedValue({ queued: true });
    dependencies.tenant.mockImplementation(
      (
        _permission: string,
        work: (sql: unknown, session: unknown) => Promise<unknown>,
      ) => work({}, { userId: "fictional-user" }),
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  describe.each(["production", "staging", "test", undefined])(
    "PLATFORM_ENV=%s",
    (environment) => {
      it.each(simulators)(
        "refuses %s before database/provider work",
        async (_name, invoke) => {
          vi.stubEnv("PLATFORM_ENV", environment);
          const response = await invoke();
          expect(response.status).toBe(403);
          expect(await response.json()).toMatchObject({
            code: "simulation_disabled",
          });
          expect(dependencies.tenant).not.toHaveBeenCalled();
          expect(dependencies.mutate).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("preserves explicitly configured development simulations", async () => {
    vi.stubEnv("PLATFORM_ENV", "development");
    expect(simulationRefusal()).toBeUndefined();
    expect(
      (await createCampaign(request({ name: "Fictional", body: "Fictional" })))
        .status,
    ).toBe(201);
    expect(dependencies.tenant).toHaveBeenCalledWith(
      "campaigns:manage",
      expect.any(Function),
    );
  });

  it("labels the legacy empty run as a simulation and no-op", async () => {
    vi.stubEnv("PLATFORM_ENV", "development");
    dependencies.mutate.mockResolvedValue("fictional-noop");
    const response = await runEmptyAutomation(request(), context);
    expect(await response.json()).toEqual({
      runId: "fictional-noop",
      mode: "simulator",
      noOp: true,
    });
  });

  it("does not disable the real Meta admission path in production", async () => {
    vi.stubEnv("PLATFORM_ENV", "production");
    const response = await outbound(
      request({
        provider: "meta",
        text: "Fictional message",
        confirmReal: true,
      }),
      context,
    );
    expect(response.status).toBe(202);
    expect(dependencies.mutate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ provider: "meta", realProviderEnabled: true }),
      expect.any(Object),
    );
  });
});
