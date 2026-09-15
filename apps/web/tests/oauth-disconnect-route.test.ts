import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assertMutation: vi.fn(),
  disconnect: vi.fn(),
  fresh: vi.fn(),
}));

vi.mock("../src/features/auth", () => ({
  jsonObject: vi.fn(),
  requestId: () => "fictional-request",
  withCurrentTenant: vi.fn(),
  withFreshCurrentTenant: state.fresh,
}));

vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.assertMutation,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "Operation failed" },
      { status: error instanceof TypeError ? 400 : 500 },
    ),
}));

vi.mock("../src/features/email", () => ({
  disconnectOAuthProvider: state.disconnect,
  oauthProvider: (value: string) => {
    if (value !== "google" && value !== "microsoft")
      throw new TypeError("Unsupported OAuth provider");
    return value;
  },
  readOAuthCredential: vi.fn(),
  saveOAuthCredential: vi.fn(),
}));

import { DELETE } from "../src/app/api/email/oauth/configuration/route";

describe("email OAuth disconnect route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.assertMutation.mockResolvedValue(undefined);
    state.disconnect.mockResolvedValue({ channels: 1, credentials: 1 });
    state.fresh.mockImplementation(
      (
        permission: string,
        operation: (sql: object, session: { userId: string }) => unknown,
      ) => {
        expect(permission).toBe("tenant:manage");
        return operation(
          {},
          { userId: "30000000-0000-4000-8000-000000000001" },
        );
      },
    );
  });

  it("uses a fresh tenant-manager authorization boundary", async () => {
    const response = await DELETE(
      new Request(
        "https://app.example.invalid/api/email/oauth/configuration?provider=google",
        { method: "DELETE" },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      disconnected: true,
      provider: "google",
      channels: 1,
      credentials: 1,
    });
    expect(state.assertMutation).toHaveBeenCalledOnce();
    expect(state.fresh).toHaveBeenCalledOnce();
    expect(state.disconnect).toHaveBeenCalledWith(
      {},
      "30000000-0000-4000-8000-000000000001",
      "google",
      "fictional-request",
    );
  });

  it("rejects an unrecognized provider before entering tenant data", async () => {
    const response = await DELETE(
      new Request(
        "https://app.example.invalid/api/email/oauth/configuration?provider=other",
        { method: "DELETE" },
      ),
    );
    expect(response.status).toBe(400);
    expect(state.fresh).not.toHaveBeenCalled();
    expect(state.disconnect).not.toHaveBeenCalled();
  });
});
