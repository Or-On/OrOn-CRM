import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assertMutation: vi.fn(),
  deleteTenant: vi.fn(),
  superuser: true,
}));

vi.mock("@or-on/crm", () => ({
  deleteTenantForAdministrator: state.deleteTenant,
}));
vi.mock("../src/features/auth", async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    requestId: () => "tenant-delete-request",
    withCurrentTenant: (
      permission: string,
      operation: (...arguments_: unknown[]) => unknown,
    ) => {
      if (permission !== "platform:read") throw new Error("wrong permission");
      return operation({}, { isSuperuser: state.superuser });
    },
  };
});
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.assertMutation,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 403 },
    ),
}));

import { DELETE } from "../src/app/api/tenants/[id]/route";

const tenantId = "20000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: tenantId }) };

describe("tenant deletion API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.superuser = true;
    state.deleteTenant.mockResolvedValue(true);
  });

  it("uses the authenticated platform-administrator database boundary", async () => {
    const response = await DELETE(
      new Request(`http://localhost/api/tenants/${tenantId}`, {
        method: "DELETE",
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(state.assertMutation).toHaveBeenCalledOnce();
    expect(state.deleteTenant).toHaveBeenCalledWith(
      {},
      tenantId,
      "tenant-delete-request",
    );
  });

  it("refuses tenant administrators who are not platform administrators", async () => {
    state.superuser = false;

    const response = await DELETE(
      new Request(`http://localhost/api/tenants/${tenantId}`, {
        method: "DELETE",
      }),
      context,
    );

    expect(response.status).toBe(403);
    expect(state.deleteTenant).not.toHaveBeenCalled();
  });

  it("returns not found without pretending deletion succeeded", async () => {
    state.deleteTenant.mockResolvedValue(false);

    const response = await DELETE(
      new Request(`http://localhost/api/tenants/${tenantId}`, {
        method: "DELETE",
      }),
      context,
    );

    expect(response.status).toBe(404);
  });
});
