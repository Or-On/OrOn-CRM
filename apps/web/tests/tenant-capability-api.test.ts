import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assertMutation: vi.fn(),
  list: vi.fn(),
  setEntitlement: vi.fn(),
  superuser: true,
}));

vi.mock("@or-on/crm", () => ({
  deleteTenantForAdministrator: vi.fn(),
  listPlatformTenants: state.list,
  setFieldServiceEntitlement: state.setEntitlement,
}));
vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ForbiddenError";
    }
  },
  jsonObject: (request: Request) => request.json(),
  requestId: () => "tenant-capability-test",
  withCurrentTenant: (
    permission: string,
    operation: (
      sql: unknown,
      session: { readonly isSuperuser: boolean },
    ) => unknown,
  ) => {
    expect(permission).toBe("platform:read");
    return operation({}, { isSuperuser: state.superuser });
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.assertMutation,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      {
        status:
          error instanceof Error && error.name === "ForbiddenError" ? 403 : 400,
      },
    ),
}));

import { PATCH } from "../src/app/api/tenants/[id]/route";

const tenantId = "30000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: tenantId }) };
const request = (fieldServiceAvailable: unknown) =>
  new Request(`http://localhost/api/tenants/${tenantId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fieldServiceAvailable }),
  });

describe("platform tenant capability boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.superuser = true;
    state.assertMutation.mockResolvedValue(undefined);
    state.setEntitlement.mockResolvedValue(undefined);
    state.list.mockResolvedValue([
      {
        id: tenantId,
        fieldServiceAvailable: true,
        fieldServiceEnabled: false,
      },
    ]);
  });

  it("requires a platform super administrator before changing entitlement", async () => {
    state.superuser = false;
    const response = await PATCH(request(true), context);

    expect(response.status).toBe(403);
    expect(state.setEntitlement).not.toHaveBeenCalled();
  });

  it("requires mutation authentication and a real boolean", async () => {
    state.assertMutation.mockRejectedValueOnce(new Error("CSRF rejected"));
    expect((await PATCH(request(true), context)).status).toBe(400);
    expect(state.setEntitlement).not.toHaveBeenCalled();

    state.assertMutation.mockResolvedValue(undefined);
    expect((await PATCH(request("true"), context)).status).toBe(400);
    expect(state.setEntitlement).not.toHaveBeenCalled();
  });

  it("persists the entitlement and returns the separately disabled activation state", async () => {
    const response = await PATCH(request(true), context);

    expect(response.status).toBe(200);
    expect(state.setEntitlement).toHaveBeenCalledWith(
      {},
      tenantId,
      true,
      "tenant-capability-test",
    );
    expect(await response.json()).toEqual({
      tenant: {
        id: tenantId,
        fieldServiceAvailable: true,
        fieldServiceEnabled: false,
      },
    });
  });
});
