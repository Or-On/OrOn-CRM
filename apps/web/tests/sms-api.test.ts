import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidCredentialsError,
  SmsChallengeRequiredError,
} from "@or-on/auth";

const state = vi.hoisted(() => ({
  login: vi.fn(),
  finish: vi.fn(),
  cookies: vi.fn(),
  guard: vi.fn(),
  password: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("../src/features/auth", async () => ({
  jsonObject: (await import("../src/features/auth/request")).jsonObject,
  requestId: () => "fictional-sms-api",
  setSessionCookies: state.cookies,
  assertAuthenticatedMutation: state.guard,
  withAuthService: (action: (service: unknown) => unknown) =>
    action({
      login: state.login,
      finishSmsLogin: state.finish,
      verifyCurrentPassword: state.password,
    }),
  withStaffSms: (action: (service: unknown) => unknown) =>
    action({ start: state.start, complete: state.complete }),
}));
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as verify } from "../src/app/api/auth/sms/route";
import { POST as account } from "../src/app/api/account/sms/route";

const id = "10000000-0000-4000-8000-000000000001";
function request(
  path: string,
  body: unknown,
  origin = "https://example.invalid",
) {
  return new Request(`https://example.invalid${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
describe("SMS authentication routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.guard.mockResolvedValue({
      userId: "fictional-user",
      sessionId: "fictional-session",
    });
    state.password.mockResolvedValue(true);
  });
  it("returns a challenge after password validation without issuing cookies", async () => {
    state.login.mockRejectedValue(
      new SmsChallengeRequiredError({
        id,
        phoneHint: "••••0124",
        expiresInSeconds: 300,
      }),
    );
    const result = await login(
      request("/api/auth/login", {
        email: "fictional@example.invalid",
        password: "fictional",
      }),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      smsChallenge: { id, phoneHint: "••••0124" },
    });
    expect(state.cookies).not.toHaveBeenCalled();
  });
  it("only issues the existing session cookies after successful SMS verification", async () => {
    state.finish.mockResolvedValue({
      sessionToken: "fictional-session-token",
      csrfToken: "fictional-csrf",
      session: { tenant: { role: "technician" }, isSuperuser: false },
    });
    const result = await verify(
      request("/api/auth/sms", { id, code: "012345" }),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true, home: "/field-service" });
    expect(state.cookies).toHaveBeenCalledWith(
      "fictional-session-token",
      "fictional-csrf",
    );
  });
  it("rejects cross-origin checks before invoking verification", async () => {
    const result = await verify(
      request("/api/auth/sms", { id, code: "012345" }, "https://other.invalid"),
    );
    expect(result.status).toBe(403);
    expect(state.finish).not.toHaveBeenCalled();
  });
  it("never sets cookies for a wrong or consumed code", async () => {
    state.finish.mockRejectedValue(new InvalidCredentialsError());
    expect(
      (await verify(request("/api/auth/sms", { id, code: "012345" }))).status,
    ).toBe(401);
    expect(state.cookies).not.toHaveBeenCalled();
  });
  it("requires the existing mutation guard and current password before enrollment", async () => {
    state.password.mockResolvedValue(false);
    const result = await account(
      request("/api/account/sms", {
        action: "start",
        purpose: "staff_enrollment",
        password: "wrong",
        phone: "+12025550124",
      }),
    );
    expect(result.status).toBe(401);
    expect(state.guard).toHaveBeenCalledOnce();
    expect(state.start).not.toHaveBeenCalled();
  });
  it("binds enrollment completion to the authenticated user and session", async () => {
    state.complete.mockResolvedValue("fictional@example.invalid");
    const result = await account(
      request("/api/account/sms", {
        action: "complete",
        purpose: "staff_enrollment",
        id,
        code: "012345",
        userId: "attacker",
      }),
    );
    expect(result.status).toBe(200);
    expect(state.complete).toHaveBeenCalledWith(
      "staff_enrollment",
      id,
      "012345",
      "fictional-sms-api",
      "fictional-user",
      "fictional-session",
    );
  });
});
