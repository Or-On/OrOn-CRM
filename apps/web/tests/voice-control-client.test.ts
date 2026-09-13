import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  current: vi.fn(),
  fresh: vi.fn(),
  grant: vi.fn(),
  fetch: vi.fn(),
  transactionOpen: false,
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({ controlApiUrl: "http://control.fixture.invalid" }),
}));
vi.mock("../src/features/auth", () => ({
  currentRawSession: boundary.current,
  withFreshCurrentTenant: boundary.fresh,
  issueControlApiGrant: boundary.grant,
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}));
import { voiceClient } from "../src/features/voice-server";

beforeEach(() => {
  vi.resetAllMocks();
  boundary.transactionOpen = false;
  boundary.grant.mockResolvedValue("fictional-short-lived-grant");
  boundary.fresh.mockImplementation(
    async (
      _permission,
      operation: (sql: unknown, session: unknown) => Promise<unknown>,
    ) => {
      boundary.transactionOpen = true;
      const result = await operation({}, { sessionId: "fresh-session" });
      boundary.transactionOpen = false;
      return result;
    },
  );
  boundary.fetch.mockImplementation(() => {
    expect(boundary.transactionOpen).toBe(false);
    return Promise.resolve(Response.json({ session_id: "fixture" }));
  });
  vi.stubGlobal("fetch", boundary.fetch);
});

describe("fresh voice control client authorization", () => {
  it.each([
    ["voice:read", "voice:read"],
    ["voice:write", "voice:operate"],
  ] as const)(
    "checks %s authorization before issuing its grant outside the database transaction",
    async (capability, permission) => {
      const controller = new AbortController();
      const client = await voiceClient(capability, {
        freshAuthorization: true,
        timeoutMs: 4_000,
        signal: controller.signal,
      });
      await client.getVoiceSessionControl({ session_id: "fixture" });
      expect(boundary.current).not.toHaveBeenCalled();
      expect(boundary.fresh).toHaveBeenCalledWith(
        permission,
        expect.any(Function),
      );
      expect(boundary.grant).toHaveBeenCalledExactlyOnceWith(
        { sessionId: "fresh-session" },
        capability,
      );
      expect(boundary.fetch).toHaveBeenCalledOnce();
      const init = boundary.fetch.mock.calls[0]?.[1] as RequestInit;
      expect(init.cache).toBe("no-store");
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer fictional-short-lived-grant",
      );
      controller.abort();
      expect(init.signal?.aborted).toBe(true);
      vi.unstubAllGlobals();
    },
  );
  it("does not issue grants or upstream requests after fresh permission failure", async () => {
    boundary.fresh.mockRejectedValue(new Error("revoked membership"));
    await expect(
      voiceClient("voice:write", { freshAuthorization: true }),
    ).rejects.toThrow("revoked membership");
    expect(boundary.grant).not.toHaveBeenCalled();
    expect(boundary.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
