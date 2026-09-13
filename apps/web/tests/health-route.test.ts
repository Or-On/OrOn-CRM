import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
  require: vi.fn(),
  live: vi.fn(),
  ready: vi.fn(),
}));
vi.mock("../src/features/auth", () => ({
  requirePublicSession: access.require,
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({
    controlApiUrl: "http://127.0.0.1:3102",
    enableRealWhatsApp: true,
    enableWhatsAppAi: true,
    enableRealTelephony: true,
    enableRealVoiceProviders: false,
    enableWhatsAppAutoCalls: false,
  }),
}));
vi.mock("@or-on/api-client", () => ({
  ControlApiClient: class {
    getLiveness = access.live;
    getReadiness = access.ready;
  },
}));
import { GET } from "../src/app/api/system/health/route";
import { UnauthenticatedError } from "../src/features/auth";

beforeEach(() => {
  vi.clearAllMocks();
  access.require.mockResolvedValue({});
});
describe("tenant health projection", () => {
  it("requires a session before probing internal services", async () => {
    access.require.mockRejectedValue(new UnauthenticatedError());
    expect((await GET()).status).toBe(401);
    expect(access.live).not.toHaveBeenCalled();
  });
  it("projects only observed status and excludes internal metadata", async () => {
    access.live.mockResolvedValue({
      ok: true,
      status: 200,
      data: { service: "private-runtime", version: "internal-version" },
    });
    access.ready.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        service: "private-runtime",
        dependencies: { postgres: "ready", privateHost: "internal-host" },
      },
    });
    const body = await (await GET()).text();
    expect(body).toContain('"postgres":"ready"');
    expect(body).toContain('"whatsappDelivery":true');
    expect(body).toContain('"voiceCalling":false');
    expect(body).toMatch(/"durationMs":\d+/);
    expect(body).not.toMatch(/private-runtime|internal-version|internal-host/);
  });
  it("never forwards an unexpected dependency object", async () => {
    access.live.mockResolvedValue({ ok: true, status: 200 });
    access.ready.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        dependencies: { postgres: { dsn: "fictional-private-infrastructure" } },
      },
    });
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("fictional-private-infrastructure");
    expect(body).toContain('"controlApi":null');
  });
});
