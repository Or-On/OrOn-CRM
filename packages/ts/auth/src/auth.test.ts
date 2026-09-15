import { describe, expect, it } from "vitest";

import {
  canonicalRoles,
  canAssignRole,
  hashOpaqueToken,
  hashPassword,
  hasPermission,
  isAuthorized,
  issueServiceAssertion,
  permissions,
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
  const expected = {
    owner: [...permissions],
    admin: [...permissions],
    agent: [
      "platform:read",
      "voice:read",
      "voice:operate",
      "crm:read",
      "crm:write",
      "pipelines:manage",
      "messaging:operate",
      "field-service:read",
      "field-service:operate",
    ],
    technician: [
      "platform:read",
      "field-service:read",
      "field-service:operate",
    ],
    viewer: ["platform:read", "voice:read", "crm:read", "field-service:read"],
  } as const;

  it.each(canonicalRoles)("enforces the exact %s permission set", (role) => {
    for (const permission of permissions) {
      expect(hasPermission(role, permission), `${role} -> ${permission}`).toBe(
        expected[role].includes(permission as never),
      );
    }
  });

  it("keeps tenant role assignment within the owner/admin boundary", () => {
    for (const actor of canonicalRoles) {
      for (const target of canonicalRoles) {
        const allowed =
          actor === "owner" || (actor === "admin" && target !== "owner");
        expect(canAssignRole(actor, target), `${actor} -> ${target}`).toBe(
          allowed,
        );
      }
    }
  });

  it("grants platform super-administrators every capability without widening tenant roles", () => {
    for (const permission of permissions) {
      expect(
        isAuthorized({ role: "viewer", isSuperuser: true }, permission),
      ).toBe(true);
    }
    expect(
      isAuthorized({ role: "viewer", isSuperuser: false }, "members:manage"),
    ).toBe(false);
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
