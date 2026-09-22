import { beforeAll, describe, expect, it } from "vitest";

import {
  AuthService,
  ForbiddenError,
  InvalidCredentialsError,
  hashPassword,
} from "./index.js";
import type {
  AuthRepository,
  AuthSession,
  CreateSessionInput,
  LoginRecord,
} from "./types.js";

const pepper = "auth-service-test-pepper-with-thirty-two-safe-characters";
const membership = {
  role: "owner" as const,
  tenantId: "10000000-0000-4000-8000-000000000001",
  tenantName: "Fixture tenant",
  tenantSlug: "fixture-tenant",
};
let encodedPassword = "";

beforeAll(async () => {
  encodedPassword = await hashPassword("correct horse battery staple");
});

function repository(login?: LoginRecord) {
  let created: CreateSessionInput | undefined;
  const session: AuthSession = {
    absoluteExpiresAt: new Date("2030-01-02T00:00:00Z"),
    csrfTokenHash: new Uint8Array(32),
    email: "operator@example.test",
    displayName: "Fixture Operator",
    isSuperuser: false,
    memberships: [membership],
    rotationCount: 0,
    sessionId: "30000000-0000-4000-8000-000000000001",
    tenant: membership,
    userId: "20000000-0000-4000-8000-000000000001",
  };
  const value: AuthRepository = {
    acceptInvitation: () => Promise.resolve(true),
    close: () => Promise.resolve(),
    createSession: (input) => {
      created = input;
      return Promise.resolve(session.sessionId);
    },
    lookupLogin: () => Promise.resolve(login),
    invitationRecord: () => Promise.resolve(undefined),
    membershipsForUser: () => Promise.resolve([membership]),
    recordLoginFailure: () => Promise.resolve(),
    recordLoginSuccess: () => Promise.resolve(),
    resolveSession: () => Promise.resolve(session),
    revokeSession: () => Promise.resolve(true),
    switchTenant: () => Promise.resolve(true),
  };
  return {
    get created() {
      return created;
    },
    session,
    value,
  };
}

describe("AuthService", () => {
  it("issues opaque session material while persisting only digests", async () => {
    const repo = repository({
      email: "operator@example.test",
      displayName: "Fixture Operator",
      failedAttempts: 0,
      isSuperuser: false,
      lockedUntil: undefined,
      passwordHash: encodedPassword,
      status: "active",
      userId: "20000000-0000-4000-8000-000000000001",
    });
    const service = new AuthService(repo.value, {
      dummyPasswordHash: encodedPassword,
      now: () => new Date("2030-01-01T00:00:00Z"),
      tokenPepper: pepper,
    });
    const issued = await service.login({
      email: "operator@example.test",
      password: "correct horse battery staple",
      requestId: "fixture-request",
    });
    expect(issued.sessionToken).toHaveLength(43);
    expect(repo.created?.tokenHash).toHaveLength(32);
    expect(
      Buffer.from(repo.created?.tokenHash ?? []).toString("utf8"),
    ).not.toContain(issued.sessionToken);
    expect(service.toPublicSession(issued.session).permissions).toContain(
      "tenant:manage",
    );
    expect(service.toPublicSession(issued.session).user.displayName).toBe(
      "Fixture Operator",
    );
  });

  it("uses one generic failure for unknown users and wrong passwords", async () => {
    const missing = new AuthService(repository().value, {
      dummyPasswordHash: encodedPassword,
      tokenPepper: pepper,
    });
    await expect(
      missing.login({
        email: "missing@example.test",
        password: "wrong",
        requestId: "one",
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("exposes every permission to a platform superuser regardless of tenant role", () => {
    const repo = repository();
    const service = new AuthService(repo.value, {
      dummyPasswordHash: encodedPassword,
      tokenPepper: pepper,
    });
    const session: AuthSession = {
      ...repo.session,
      isSuperuser: true,
      tenant: { ...repo.session.tenant, role: "viewer" },
    };

    expect(service.toPublicSession(session).permissions).toContain(
      "members:change-role",
    );
    expect(service.toPublicSession(session).permissions).toContain(
      "tenant:manage",
    );
  });

  it("publishes the Field Service application scope for technician sessions", () => {
    const repo = repository();
    const service = new AuthService(repo.value, {
      dummyPasswordHash: encodedPassword,
      tokenPepper: pepper,
    });
    const technician: AuthSession = {
      ...repo.session,
      tenant: { ...repo.session.tenant, role: "technician" },
    };
    const published = service.toPublicSession(technician);
    expect(published.applicationScope).toBe("field-service");
    expect(published.permissions).toEqual([
      "field-service:read",
      "field-service:operate",
    ]);
    expect(service.toPublicSession(repo.session).applicationScope).toBe(
      "workspace",
    );
  });

  it("keeps sibling sessions of one account valid across login and logout", async () => {
    const technician = {
      ...membership,
      role: "technician" as const,
    };
    const sessions = new Map<string, AuthSession>();
    const revoked: string[] = [];
    const key = (hash: Uint8Array) => Buffer.from(hash).toString("hex");
    const shared: AuthRepository = {
      acceptInvitation: () => Promise.resolve(true),
      close: () => Promise.resolve(),
      createSession: (input) => {
        const sessionId = `30000000-0000-4000-8000-${String(sessions.size + 1).padStart(12, "0")}`;
        sessions.set(key(input.tokenHash), {
          absoluteExpiresAt: input.absoluteExpiresAt,
          csrfTokenHash: input.csrfTokenHash,
          displayName: "Shared technicians",
          email: "technicians@example.test",
          isSuperuser: false,
          memberships: [technician],
          rotationCount: 0,
          sessionId,
          tenant: technician,
          userId: "20000000-0000-4000-8000-000000000001",
        });
        return Promise.resolve(sessionId);
      },
      lookupLogin: () =>
        Promise.resolve({
          email: "technicians@example.test",
          displayName: "Shared technicians",
          failedAttempts: 0,
          isSuperuser: false,
          lockedUntil: undefined,
          passwordHash: encodedPassword,
          status: "active",
          userId: "20000000-0000-4000-8000-000000000001",
        }),
      invitationRecord: () => Promise.resolve(undefined),
      membershipsForUser: () => Promise.resolve([technician]),
      recordLoginFailure: () => Promise.resolve(),
      recordLoginSuccess: () => Promise.resolve(),
      resolveSession: (hash) => Promise.resolve(sessions.get(key(hash))),
      revokeSession: (hash) => {
        revoked.push(key(hash));
        return Promise.resolve(sessions.delete(key(hash)));
      },
      switchTenant: () => Promise.resolve(true),
    };
    const service = new AuthService(shared, {
      dummyPasswordHash: encodedPassword,
      tokenPepper: pepper,
    });
    const credentials = {
      email: "technicians@example.test",
      password: "correct horse battery staple",
    };
    const tabletA = await service.login({ ...credentials, requestId: "a" });
    const tabletB = await service.login({ ...credentials, requestId: "b" });

    expect(tabletA.session.userId).toBe(tabletB.session.userId);
    expect(tabletA.session.sessionId).not.toBe(tabletB.session.sessionId);
    expect(tabletA.sessionToken).not.toBe(tabletB.sessionToken);
    expect(revoked).toEqual([]);
    expect((await service.resolve(tabletA.sessionToken))?.sessionId).toBe(
      tabletA.session.sessionId,
    );
    expect((await service.resolve(tabletB.sessionToken))?.sessionId).toBe(
      tabletB.session.sessionId,
    );

    await service.logout(tabletA.sessionToken, "logout-a");
    expect(revoked).toHaveLength(1);
    expect(await service.resolve(tabletA.sessionToken)).toBeUndefined();
    expect((await service.resolve(tabletB.sessionToken))?.sessionId).toBe(
      tabletB.session.sessionId,
    );
  });

  it("requires the CSRF cookie, header, and session digest to agree", () => {
    const repo = repository();
    const service = new AuthService(repo.value, {
      dummyPasswordHash: encodedPassword,
      tokenPepper: pepper,
    });
    expect(() => service.validateCsrf(repo.session, "one", "two")).toThrow(
      ForbiddenError,
    );
  });
});
