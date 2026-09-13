import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  auth: vi.fn(),
  client: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: boundary.auth,
  jsonObject: (request: Request) => request.json(),
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}));
vi.mock("../src/features/voice-server", () => ({
  voiceClient: boundary.client,
}));
import { GET, POST } from "../src/app/api/voice/sessions/[id]/control/route";
import { ForbiddenError, UnauthenticatedError } from "../src/features/auth";

const id = "40000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const body = {
  mode: "paused",
  expected_epoch: 3,
  idempotency_key: "fixture-control-1",
};
const receipt = {
  session_id: id,
  epoch: 4,
  status: "pending",
  human_connection: "not_managed",
};
function request(value: unknown = body) {
  return new Request(`http://localhost/api/voice/sessions/${id}/control`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "fictional",
    },
    body: JSON.stringify(value),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  boundary.auth.mockResolvedValue({});
  boundary.client.mockResolvedValue({
    getVoiceSessionControl: boundary.get,
    setVoiceSessionControl: boundary.set,
  });
  boundary.get.mockResolvedValue({ ok: true, status: 200, data: receipt });
  boundary.set.mockResolvedValue({ ok: true, status: 200, data: receipt });
});

describe("voice AI control BFF", () => {
  it("reads through fresh voice:read authorization with no caching or mutation", async () => {
    const input = new Request("http://localhost");
    const response = await GET(input, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(receipt);
    expect(boundary.client).toHaveBeenCalledExactlyOnceWith("voice:read", {
      freshAuthorization: true,
      timeoutMs: 4_000,
      signal: input.signal,
    });
    expect(boundary.get).toHaveBeenCalledExactlyOnceWith({ session_id: id });
    expect(boundary.set).not.toHaveBeenCalled();
  });
  it.each(["paused", "ai"])(
    "forwards exact %s command using fresh voice:write authorization after CSRF",
    async (mode) => {
      const input = request({ ...body, mode });
      const response = await POST(input, context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(receipt);
      expect(boundary.auth).toHaveBeenCalledExactlyOnceWith(input);
      expect(boundary.client).toHaveBeenCalledExactlyOnceWith("voice:write", {
        freshAuthorization: true,
        timeoutMs: 4_000,
        signal: input.signal,
      });
      expect(boundary.set).toHaveBeenCalledExactlyOnceWith(
        { session_id: id },
        { ...body, mode },
      );
    },
  );
  it.each([
    [new ForbiddenError("private CSRF"), 403],
    [new UnauthenticatedError("private auth"), 401],
  ])(
    "rejects mutation authentication before API work",
    async (error, status) => {
      boundary.auth.mockRejectedValue(error);
      expect((await POST(request(), context)).status).toBe(status);
      expect(boundary.client).not.toHaveBeenCalled();
    },
  );
  it("blocks a viewer at the fresh write authorization", async () => {
    boundary.client.mockRejectedValue(new ForbiddenError());
    expect((await POST(request(), context)).status).toBe(403);
    expect(boundary.set).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, mode: "human" },
    { ...body, expected_epoch: -1 },
    { ...body, expected_epoch: 1.1 },
    { ...body, expected_epoch: true },
    { ...body, expected_epoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...body, idempotency_key: "short" },
    { ...body, idempotency_key: " ".repeat(10) },
    { ...body, idempotency_key: "x".repeat(129) },
    { ...body, tenant_id: "forged" },
  ])("rejects malformed commands without upstream writes", async (value) => {
    expect((await POST(request(value), context)).status).toBe(400);
    expect(boundary.client).not.toHaveBeenCalled();
  });
  it("rejects malformed session identifiers before lookup", async () => {
    expect(
      (
        await GET(new Request("http://localhost"), {
          params: Promise.resolve({ id: "../other" }),
        })
      ).status,
    ).toBe(400);
    expect(boundary.client).not.toHaveBeenCalled();
  });
  it("preserves stale-epoch 409 without leaking upstream details or retrying", async () => {
    boundary.set.mockResolvedValue({
      ok: false,
      status: 409,
      data: { detail: "private tenant information" },
    });
    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Call control changed. Reload its current status.",
    });
    expect(boundary.set).toHaveBeenCalledOnce();
  });
  it("treats a network TypeError as uncertain 503, not a rejected command", async () => {
    boundary.set.mockRejectedValue(new TypeError("fetch failed: private URL"));
    const response = await POST(request(), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "Call control result is unavailable. Check its status before retrying.",
    });
    expect(boundary.set).toHaveBeenCalledOnce();
  });
});
