import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  csrf: vi.fn(),
  fresh: vi.fn(),
  grant: vi.fn(),
  preview: vi.fn(),
  evaluate: vi.fn(),
  authorized: true,
  inTransaction: false,
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({ controlApiUrl: "http://fixture.invalid" }),
}));
vi.mock("@or-on/api-client", () => ({
  ControlApiClient: class {
    evaluateAgentProvider(body: unknown) {
      expect(api.inTransaction).toBe(false);
      return api.evaluate(body) as Promise<unknown>;
    }
    previewAgentAudio(body: unknown) {
      expect(api.inTransaction).toBe(false);
      return api.preview(body) as Promise<unknown>;
    }
  },
}));
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: api.csrf,
  ForbiddenError: class extends Error {},
  UnauthenticatedError: class extends Error {},
  issueControlApiGrant: api.grant,
  jsonObject: (request: Request) => request.json(),
  withFreshCurrentTenant: async (
    permission: string,
    operation: (sql: unknown, session: unknown) => unknown,
  ) => {
    api.fresh(permission);
    if (!api.authorized)
      throw Object.assign(new Error("Forbidden"), { code: "42501" });
    api.inTransaction = true;
    try {
      return await operation({}, {});
    } finally {
      api.inTransaction = false;
    }
  },
}));
import { POST } from "../src/app/api/orchestration/agents/[id]/audio-preview/route";
import { POST as evaluate } from "../src/app/api/orchestration/agents/[id]/provider-evaluate/route";
const id = "10000000-0000-4000-8000-000000000001";
const versionId = "20000000-0000-4000-8000-000000000001";
const body = { versionId, text: "Fictional", confirmed: true };
const request = (value: unknown) =>
  new Request(
    "http://localhost/api/orchestration/agents/fixture/audio-preview",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    },
  );
const context = { params: Promise.resolve({ id }) };
beforeEach(() => {
  vi.clearAllMocks();
  api.authorized = true;
  api.csrf.mockResolvedValue(undefined);
  api.grant.mockResolvedValue("fixture-assertion");
  api.preview.mockResolvedValue({
    ok: true,
    status: 200,
    data: { version_id: versionId },
  });
});
describe("paid preview BFF boundary", () => {
  it("protects actual model evaluation with the same fresh permission and CSRF boundary", async () => {
    api.evaluate.mockResolvedValue({
      ok: true,
      status: 200,
      data: { version_id: versionId },
    });
    const response = await evaluate(request(body), context);
    expect(response.status).toBe(200);
    expect(api.fresh).toHaveBeenCalledWith("flows:manage");
    expect(api.csrf).toHaveBeenCalledOnce();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    api.authorized = false;
    expect((await evaluate(request(body), context)).status).toBe(403);
    expect(api.evaluate).toHaveBeenCalledOnce();
  });
  it("fresh manager and CSRF finish before provider HTTP; response private", async () => {
    const response = await POST(request(body), context);
    expect(response.status).toBe(200);
    expect(api.fresh).toHaveBeenCalledWith("flows:manage");
    expect(api.csrf).toHaveBeenCalledOnce();
    expect(api.preview).toHaveBeenCalledWith({
      agent_id: id,
      version_id: versionId,
      text: "Fictional",
      confirmed: true,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("viewer and missing CSRF cannot spend", async () => {
    api.authorized = false;
    expect((await POST(request(body), context)).status).toBe(403);
    api.authorized = true;
    api.csrf.mockRejectedValue({ code: "42501" });
    expect((await POST(request(body), context)).status).toBe(403);
    expect(api.preview).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, confirmed: false },
    { ...body, text: "x".repeat(301) },
    { ...body, api_key: "forbidden" },
  ])("rejects unsafe request without inference", async (value) => {
    expect((await POST(request(value), context)).status).toBe(400);
    expect(api.preview).not.toHaveBeenCalled();
  });
});
