import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Auth from "@or-on/auth";

const state = vi.hoisted(() => ({
  resolve: vi.fn(),
  sql: vi.fn(),
  operation: vi.fn(),
  inside: false,
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
  return {
    ...actual,
    createAuthRepository: () => ({ close: () => Promise.resolve() }),
    AuthService: class {
      resolve = state.resolve;
      toPublicSession() {
        return {};
      }
    },
    withTenantTransaction: async (
      _database: string,
      _identity: unknown,
      work: (sql: unknown) => unknown,
    ) => {
      state.inside = true;
      try {
        return await work(state.sql);
      } finally {
        state.inside = false;
      }
    },
  };
});
import { withFreshCurrentTenant } from "./server";

describe("fresh authorization transaction boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.resolve.mockResolvedValue({
      sessionId: "session",
      userId: "user",
      isSuperuser: false,
      rotationCount: 2,
      tenant: { tenantId: "tenant", role: "admin" },
    });
    state.sql.mockImplementation(() => {
      expect(state.inside).toBe(true);
      return Promise.resolve([{ allowed: true }]);
    });
    state.operation.mockImplementation(() => {
      expect(state.inside).toBe(true);
      return Promise.resolve("stored");
    });
  });
  it("locks the exact current session, role and rotation before writing in the same transaction", async () => {
    expect(await withFreshCurrentTenant("tenant:manage", state.operation)).toBe(
      "stored",
    );
    expect(state.sql.mock.calls[0]?.slice(1)).toEqual([
      "session",
      "admin",
      false,
      2,
    ]);
    expect(state.sql.mock.invocationCallOrder[0]).toBeLessThan(
      state.operation.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("accepts a canonical technician for a freshly authorized field-service operation", async () => {
    state.resolve.mockResolvedValueOnce({
      sessionId: "technician-session",
      userId: "technician-user",
      isSuperuser: false,
      rotationCount: 4,
      tenant: { tenantId: "tenant", role: "technician" },
    });

    expect(
      await withFreshCurrentTenant("field-service:operate", state.operation),
    ).toBe("stored");
    expect(state.sql.mock.calls[0]?.slice(1)).toEqual([
      "technician-session",
      "technician",
      false,
      4,
    ]);
  });
  it("does not write if authorization changed after the initial resolve", async () => {
    state.sql.mockResolvedValueOnce([{ allowed: false }]);
    await expect(
      withFreshCurrentTenant("tenant:manage", state.operation),
    ).rejects.toThrow("Forbidden");
    expect(state.operation).not.toHaveBeenCalled();
  });
  it("fails closed before database work if the browser session disappeared", async () => {
    state.resolve.mockResolvedValueOnce(undefined);
    await expect(
      withFreshCurrentTenant("tenant:manage", state.operation),
    ).rejects.toThrow("Unauthenticated");
    expect(state.sql).not.toHaveBeenCalled();
    expect(state.operation).not.toHaveBeenCalled();
  });
});
