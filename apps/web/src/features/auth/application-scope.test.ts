import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Auth from "@or-on/auth";

const state = vi.hoisted(() => ({
  role: "technician",
  operation: vi.fn(() => Promise.resolve("stored")),
}));
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => ({ value: "fictional-token" }) }),
}));
vi.mock("@or-on/config", () => ({
  loadConfig: () => ({
    databaseUrl: "postgresql://fictional.invalid/db",
    environment: "test",
    secrets: {
      authTokenPepper: "fictional",
      authServiceSecret: "fictional",
      authDummyPasswordHash: "fictional",
    },
  }),
}));
vi.mock("@or-on/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof Auth>();
  const session = () => ({
    sessionId: "30000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000001",
    isSuperuser: false,
    rotationCount: 0,
    tenant: {
      tenantId: "10000000-0000-4000-8000-000000000001",
      role: state.role,
    },
  });
  return {
    ...actual,
    createAuthRepository: () => ({ close: () => Promise.resolve() }),
    AuthService: class {
      resolve = () => Promise.resolve(session());
      toPublicSession() {
        return {
          applicationScope: actual.applicationScope({
            role: state.role === "owner" ? "owner" : "technician",
            isSuperuser: false,
          }),
        };
      }
    },
    withTenantTransaction: (
      _database: string,
      _identity: unknown,
      work: (sql: unknown) => unknown,
    ) => work({}),
  };
});
import {
  ForbiddenError,
  requirePublicSession,
  withCurrentShellTenant,
  withCurrentTenant,
} from "./server";

describe("technician application scope on the server", () => {
  beforeEach(() => {
    state.role = "technician";
    state.operation.mockClear();
  });

  it.each([
    "platform:read",
    "crm:read",
    "members:manage",
    "tenant:manage",
  ] as const)(
    "denies a technician the workspace permission %s before any database work",
    async (permission) => {
      await expect(
        withCurrentTenant(permission, state.operation),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(state.operation).not.toHaveBeenCalled();
    },
  );

  it("keeps the technician's Field Service work and shell presentation", async () => {
    expect(await withCurrentTenant("field-service:read", state.operation)).toBe(
      "stored",
    );
    expect(
      await withCurrentTenant("field-service:operate", state.operation),
    ).toBe("stored");
    expect(await withCurrentShellTenant(state.operation)).toBe("stored");
    await expect(
      withCurrentTenant("field-service:manage", state.operation),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps workspace-only sessions out of the technician app and vice versa", async () => {
    await expect(
      requirePublicSession({ application: "workspace" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await requirePublicSession()).applicationScope).toBe(
      "field-service",
    );
    state.role = "owner";
    expect(
      (await requirePublicSession({ application: "workspace" }))
        .applicationScope,
    ).toBe("workspace");
    expect(await withCurrentTenant("platform:read", state.operation)).toBe(
      "stored",
    );
  });
});
