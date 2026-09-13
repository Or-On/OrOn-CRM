import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthModule from "@or-on/auth";

const state = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  clearSessionCookies: vi.fn(),
  inspectInvitation: vi.fn(),
  login: vi.fn(),
  setSessionCookies: vi.fn(),
  closeFails: false,
}));

vi.mock("@or-on/auth", async (importOriginal) => {
  const original = await importOriginal<typeof AuthModule>();
  return {
    ...original,
    assertTrustedUnsafeRequest: vi.fn(),
    clientAddress: () => "127.0.0.1",
  };
});
vi.mock("../src/features/auth", () => ({
  clearSessionCookies: state.clearSessionCookies,
  jsonObject: (request: Request) => request.json(),
  requestId: () => "invitation-request",
  setSessionCookies: state.setSessionCookies,
  withAuthService: (
    operation: (service: {
      acceptInvitation: typeof state.acceptInvitation;
      inspectInvitation: typeof state.inspectInvitation;
      login: typeof state.login;
    }) => unknown,
  ) =>
    Promise.resolve(
      operation({
        acceptInvitation: state.acceptInvitation,
        inspectInvitation: state.inspectInvitation,
        login: state.login,
      }),
    ).then((result) => {
      if (state.closeFails) throw new Error("repository close failure");
      return result;
    }),
}));

import { POST } from "../src/app/api/auth/invitations/accept/route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/auth/invitations/accept", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "user-agent": "fictional-browser",
    },
    method: "POST",
  });
}

describe("invitation acceptance session transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.closeFails = false;
    state.inspectInvitation.mockResolvedValue({
      email: "new-member@example.invalid",
      existingAccount: false,
      role: "agent",
      tenantName: "Invited workspace",
    });
    state.acceptInvitation.mockResolvedValue({ accountCreated: true });
    state.login.mockResolvedValue({
      csrfToken: "new-csrf-token",
      sessionToken: "new-session-token",
    });
  });

  it("replaces an existing browser identity with the newly invited account", async () => {
    const response = await POST(
      request({
        displayName: "New Member",
        password: "a-secure-fictional-password",
        token: "x".repeat(48),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accountCreated: true,
      signedIn: true,
    });
    expect(state.login).toHaveBeenCalledWith({
      email: "new-member@example.invalid",
      ipAddress: "127.0.0.1",
      password: "a-secure-fictional-password",
      requestId: "invitation-request",
      userAgent: "fictional-browser",
    });
    expect(state.setSessionCookies).toHaveBeenCalledWith(
      "new-session-token",
      "new-csrf-token",
    );
    expect(state.clearSessionCookies).not.toHaveBeenCalled();
  });

  it("clears the previous identity before an existing account signs in", async () => {
    state.inspectInvitation.mockResolvedValue({
      email: "existing-member@example.invalid",
      existingAccount: true,
      role: "viewer",
      tenantName: "Invited workspace",
    });
    state.acceptInvitation.mockResolvedValue({ accountCreated: false });

    const response = await POST(request({ token: "y".repeat(48) }));

    expect(await response.json()).toEqual({
      accountCreated: false,
      signedIn: false,
    });
    expect(state.login).not.toHaveBeenCalled();
    expect(state.clearSessionCookies).toHaveBeenCalledOnce();
    expect(state.setSessionCookies).not.toHaveBeenCalled();
  });

  it("preserves committed acceptance and clears old cookies when automatic login fails", async () => {
    state.login.mockRejectedValueOnce(new Error("private backend error"));
    const response = await POST(
      request({ token: "x".repeat(48), password: "fictional-password" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accountCreated: true,
      signedIn: false,
    });
    expect(state.acceptInvitation).toHaveBeenCalledOnce();
    expect(state.clearSessionCookies).toHaveBeenCalledOnce();
    expect(state.setSessionCookies).not.toHaveBeenCalled();
  });

  it("clears the old identity if writing the replacement cookies fails", async () => {
    state.setSessionCookies.mockRejectedValueOnce(new Error("cookie failure"));
    const response = await POST(
      request({ token: "x".repeat(48), password: "fictional-password" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accountCreated: true,
      signedIn: false,
    });
    expect(state.clearSessionCookies).toHaveBeenCalledOnce();
  });

  it("reports accepted-needs-login if repository teardown fails after commit", async () => {
    state.closeFails = true;
    const response = await POST(
      request({ token: "x".repeat(48), password: "fictional-password" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accountCreated: true,
      signedIn: false,
    });
    expect(state.clearSessionCookies).toHaveBeenCalledOnce();
  });
});
