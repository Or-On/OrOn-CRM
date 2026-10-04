import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  requireTenantFeature: vi.fn(),
  listExpensePage: vi.fn(),
  createExpense: vi.fn(),
  updateExpense: vi.fn(),
  voidExpense: vi.fn(),
  assertCrmMutation: vi.fn(),
  withCurrentTenant: vi.fn(),
}));
vi.mock("@or-on/crm", () => ({
  requireTenantFeature: dependencies.requireTenantFeature,
  listExpensePage: dependencies.listExpensePage,
  createExpense: dependencies.createExpense,
  updateExpense: dependencies.updateExpense,
  voidExpense: dependencies.voidExpense,
}));
vi.mock("../src/features/auth", () => ({
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: dependencies.withCurrentTenant,
}));
vi.mock("../src/features/crm-route", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertCrmMutation: dependencies.assertCrmMutation,
}));

import { GET, POST } from "../src/app/api/finance/expenses/route";
import { PATCH, DELETE } from "../src/app/api/finance/expenses/[id]/route";

const id = "10000000-0000-4000-8000-000000000001";
const sql = {};
const session = { userId: "actor" };
const input = {
  title: "Synthetic",
  category: "test",
  amount: "1",
  currency: "USD",
  incurredAt: "2026-10-04T00:00:00Z",
};
const operations = [
  [
    "GET",
    () => GET(new Request("http://localhost/api/finance/expenses")),
    dependencies.listExpensePage,
    200,
  ],
  [
    "POST",
    () =>
      POST(
        new Request("http://localhost/api/finance/expenses", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
    dependencies.createExpense,
    201,
  ],
  [
    "PATCH",
    () =>
      PATCH(
        new Request("http://localhost", {
          method: "PATCH",
          body: JSON.stringify({ title: "Updated" }),
        }),
        { params: Promise.resolve({ id }) },
      ),
    dependencies.updateExpense,
    200,
  ],
  [
    "DELETE",
    () =>
      DELETE(new Request("http://localhost", { method: "DELETE" }), {
        params: Promise.resolve({ id }),
      }),
    dependencies.voidExpense,
    200,
  ],
] as const;

describe("expense API server feature boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dependencies.withCurrentTenant.mockImplementation(
      (
        _capability: string,
        callback: (
          database: typeof sql,
          actor: typeof session,
        ) => Promise<unknown>,
      ) => callback(sql, session),
    );
    dependencies.listExpensePage.mockResolvedValue({
      expenses: [],
      nextCursor: null,
    });
    for (const fn of [
      dependencies.createExpense,
      dependencies.updateExpense,
      dependencies.voidExpense,
    ])
      fn.mockResolvedValue({ id });
  });
  it.each(operations)(
    "denies %s when billing is disabled before reading or changing expenses",
    async (_name, invoke, fn) => {
      dependencies.requireTenantFeature.mockRejectedValue(
        Object.assign(new Error("Billing is disabled"), {
          code: "TENANT_FEATURE_DISABLED",
        }),
      );
      const response = await invoke();
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Billing is disabled",
        code: "TENANT_FEATURE_DISABLED",
      });
      expect(dependencies.requireTenantFeature).toHaveBeenCalledWith(
        sql,
        "billing",
      );
      expect(fn).not.toHaveBeenCalled();
    },
  );
  it.each(operations)(
    "allows %s under the existing tenant permission when billing is enabled",
    async (_name, invoke, fn, status) => {
      const response = await invoke();
      expect(response.status).toBe(status);
      expect(dependencies.withCurrentTenant).toHaveBeenCalledWith(
        "tenant:manage",
        expect.any(Function),
      );
      expect(fn).toHaveBeenCalledOnce();
      expect(
        dependencies.requireTenantFeature.mock.invocationCallOrder[0] ??
          Infinity,
      ).toBeLessThan(fn.mock.invocationCallOrder[0] ?? -Infinity);
    },
  );
  it("keeps CSRF checks before the mutation boundary", async () => {
    dependencies.assertCrmMutation.mockRejectedValue(
      Object.assign(new Error("Invalid CSRF token"), { code: "42501" }),
    );
    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
    expect(response.status).toBe(403);
    expect(dependencies.withCurrentTenant).not.toHaveBeenCalled();
    expect(dependencies.createExpense).not.toHaveBeenCalled();
  });
});
