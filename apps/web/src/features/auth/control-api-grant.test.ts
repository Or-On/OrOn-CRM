import { describe, expect, it, vi } from "vitest";
import type * as Auth from "@or-on/auth";

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({
    databaseUrl: "postgresql://fictional.invalid/db",
    environment: "test",
    secrets: {
      authTokenPepper: "fictional",
      authServiceSecret: "fictional-service-secret-long-enough-for-tests",
      authDummyPasswordHash: "fictional",
    },
  }),
}));
vi.mock("@or-on/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof Auth>();
  return {
    ...actual,
    issueServiceAssertion: (input: { capability?: string }) =>
      Promise.resolve(`assertion:${input.capability ?? ""}`),
  };
});
import { issueControlApiGrant } from "./server";

function session(role: Auth.Role, isSuperuser = false): Auth.AuthSession {
  return {
    sessionId: "session",
    userId: "user",
    isSuperuser,
    rotationCount: 0,
    tenant: { tenantId: "tenant", role },
  } as unknown as Auth.AuthSession;
}

describe("control-api voice grants", () => {
  it("lets an agent operate calls but never manage voice configuration", async () => {
    await expect(
      issueControlApiGrant(session("agent"), "voice:write"),
    ).resolves.toBe("assertion:voice:write");
    await expect(
      issueControlApiGrant(session("agent"), "voice:manage"),
    ).rejects.toThrow("Forbidden");
    await expect(
      issueControlApiGrant(session("viewer"), "voice:manage"),
    ).rejects.toThrow("Forbidden");
  });

  it("issues voice:manage to flows and campaigns managers", async () => {
    for (const role of ["owner", "admin"] as const) {
      await expect(
        issueControlApiGrant(session(role), "voice:manage"),
      ).resolves.toBe("assertion:voice:manage");
    }
    await expect(
      issueControlApiGrant(session("viewer", true), "voice:manage"),
    ).resolves.toBe("assertion:voice:manage");
  });
});
