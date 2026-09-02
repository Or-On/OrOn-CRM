import { describe, expect, it } from "vitest";

import {
  canAssignRole,
  hashOpaqueToken,
  hashPassword,
  hasPermission,
  issueServiceAssertion,
  tokenDigestMatches,
  verifyPassword,
  verifyServiceAssertion,
} from "./index.js";

const secret = "phase-three-test-secret-with-at-least-thirty-two-characters";

describe("authentication cryptography", () => {
  it("uses Argon2id password hashes", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(encoded).toMatch(/^\$argon2id\$/u);
    await expect(
      verifyPassword(encoded, "correct horse battery staple"),
    ).resolves.toBe(true);
    await expect(verifyPassword(encoded, "wrong password")).resolves.toBe(
      false,
    );
  });

  it("stores deterministic token digests rather than raw tokens", () => {
    const digest = hashOpaqueToken("opaque-session-token", secret);
    const matching = hashOpaqueToken("opaque-session-token", secret);
    const other = hashOpaqueToken("different-session-token", secret);
    expect(Buffer.from(digest).toString("hex")).not.toContain(
      "opaque-session-token",
    );
    expect(tokenDigestMatches(digest, matching)).toBe(true);
    expect(tokenDigestMatches(digest, other)).toBe(false);
  });
});

describe("authorization", () => {
  it("denies privileged actions to non-privileged roles", () => {
    expect(hasPermission("viewer", "members:manage")).toBe(false);
    expect(hasPermission("agent", "tenant:manage")).toBe(false);
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(hasPermission("viewer", "voice:read")).toBe(true);
    expect(hasPermission("viewer", "voice:operate")).toBe(false);
    expect(hasPermission("agent", "voice:operate")).toBe(true);
  });
});

describe("service assertions", () => {
  it("binds short-lived identity assertions to the intended audience", async () => {
    const token = await issueServiceAssertion({
      secret,
      audience: "live-agent",
      capability: "live-session",
      identity: {
        userId: "00000000-0000-4000-8000-000000000001",
        tenantId: "00000000-0000-4000-8000-000000000002",
        sessionId: "00000000-0000-4000-8000-000000000003",
        role: "agent",
      },
    });
    await expect(
      verifyServiceAssertion({ token, secret, audience: "live-agent" }),
    ).resolves.toMatchObject({ role: "agent", capability: "live-session" });
    await expect(
      verifyServiceAssertion({ token, secret, audience: "control-api" }),
    ).rejects.toThrow("service assertion is invalid");
  });
});
