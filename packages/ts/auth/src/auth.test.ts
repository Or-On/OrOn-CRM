import { describe, expect, it } from "vitest";

import {
  applicationHome,
  applicationScope,
  canonicalRoles,
  canAssignRole,
  hashOpaqueToken,
  hashPassword,
  hasPermission,
  isAuthorized,
  isAuthorizedInApplication,
  isPathInApplicationScope,
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

  it("confines technicians to the Field Service application without shrinking their role", () => {
    const technician = { role: "technician", isSuperuser: false } as const;
    expect(applicationScope(technician)).toBe("field-service");
    expect(applicationHome[applicationScope(technician)]).toBe(
      "/field-service",
    );
    // The role still carries platform:read for the application shell...
    expect(isAuthorized(technician, "platform:read")).toBe(true);
    // ...but no workspace page or API accepts it from the technician app.
    expect(isAuthorizedInApplication(technician, "platform:read")).toBe(false);
    expect(isAuthorizedInApplication(technician, "crm:read")).toBe(false);
    expect(isAuthorizedInApplication(technician, "field-service:operate")).toBe(
      true,
    );
    expect(isAuthorizedInApplication(technician, "field-service:manage")).toBe(
      false,
    );
    for (const role of canonicalRoles.filter((item) => item !== "technician")) {
      const principal = { role, isSuperuser: false };
      expect(applicationScope(principal)).toBe("workspace");
      for (const permission of permissions)
        expect(isAuthorizedInApplication(principal, permission)).toBe(
          isAuthorized(principal, permission),
        );
    }
    expect(applicationScope({ role: "technician", isSuperuser: true })).toBe(
      "workspace",
    );
  });

  it("maps only Field Service and sign-in routes into the technician application", () => {
    for (const path of [
      "/field-service",
      "/field-service/cases/10000000-0000-4000-8000-000000000001",
      "/field-service/reports?status=finalized",
      "/login",
      "/invite/token",
    ])
      expect(isPathInApplicationScope("field-service", path), path).toBe(true);
    for (const path of [
      "/",
      "/inbox",
      "/contacts/1",
      "/profile",
      "/settings",
      "/settings/business",
      "/system/health",
      "/users",
      "/roles",
      "/tenants",
      "/start",
      "/field-services",
    ])
      expect(isPathInApplicationScope("field-service", path), path).toBe(false);
    expect(isPathInApplicationScope("workspace", "/profile")).toBe(true);
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
