import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tenantId: "tenant-a",
  images: new Map<
    string,
    { data: Uint8Array; contentType: string; updatedAt: string }
  >(),
  read: vi.fn(),
  write: vi.fn(),
  guard: vi.fn(),
  permission: vi.fn(),
}));
vi.mock("@or-on/crm", () => ({
  getCurrentTenantLogo: state.read,
  setCurrentTenantLogo: state.write,
}));
vi.mock("../src/features/auth", () => ({
  requestId: () => "logo-regression",
  withCurrentTenant: (
    permission: string,
    action: (
      sql: { tenantId: string },
      session: { tenant: { tenantId: string } },
    ) => unknown,
  ) => {
    state.permission(permission);
    return action(
      { tenantId: state.tenantId },
      { tenant: { tenantId: state.tenantId } },
    );
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.guard,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "Refused" },
      { status: 400 },
    ),
}));

import { DELETE, GET, PATCH } from "../src/app/api/settings/logo/route";

const logoA = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
]);
const logoB = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2,
]);
function request(method = "GET", context: string | null = state.tenantId) {
  const body = new FormData();
  body.set("image", new File([logoA], "logo.png", { type: "image/png" }));
  return new Request(
    `https://example.invalid/api/settings/logo${context === null ? "" : `?context=${context}`}`,
    {
      method,
      ...(method === "PATCH" ? { body } : {}),
    },
  );
}

describe("tenant logo endpoint isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.tenantId = "tenant-a";
    state.images.clear();
    state.images.set("tenant-b", {
      data: logoB,
      contentType: "image/png",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    state.guard.mockResolvedValue(undefined);
    state.read.mockImplementation((sql: { tenantId: string }) =>
      Promise.resolve(state.images.get(sql.tenantId)),
    );
    state.write.mockImplementation(
      (
        sql: { tenantId: string },
        image: { data: Uint8Array; contentType: string } | undefined,
      ) => {
        if (image)
          state.images.set(sql.tenantId, {
            ...image,
            updatedAt: "2026-09-20T00:00:00Z",
          });
        else state.images.delete(sql.tenantId);
        return Promise.resolve();
      },
    );
  });

  it("uploads and removes only the authenticated matching tenant, leaving the other logo unchanged", async () => {
    expect((await PATCH(request("PATCH"))).status).toBe(200);
    expect(state.permission).toHaveBeenCalledWith("tenant:manage");
    expect(state.guard).toHaveBeenCalledOnce();
    const first = await GET(request());
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(logoA);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    state.tenantId = "tenant-b";
    const other = await GET(request());
    expect(new Uint8Array(await other.arrayBuffer())).toEqual(logoB);
    state.tenantId = "tenant-a";
    expect((await DELETE(request("DELETE"))).status).toBe(200);
    const absent = await GET(request());
    expect(absent.status).toBe(404);
    expect(absent.headers.get("cache-control")).toBe("private, no-store");
    expect(state.images.get("tenant-b")?.data).toEqual(logoB);
  });

  it.each([GET, PATCH, DELETE])(
    "refuses stale tenant context before reading or writing another logo",
    async (handler) => {
      state.tenantId = "tenant-b";
      const method =
        handler === PATCH ? "PATCH" : handler === DELETE ? "DELETE" : "GET";
      const response = await handler(request(method, "tenant-a"));
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        error: "Workspace changed. Refresh before changing its logo.",
      });
      expect(state.read).not.toHaveBeenCalled();
      expect(state.write).not.toHaveBeenCalled();
    },
  );

  it.each([PATCH, DELETE])(
    "requires a rendered tenant context for logo mutations",
    async (handler) => {
      const response = await handler(
        request(handler === PATCH ? "PATCH" : "DELETE", null),
      );
      expect(response.status).toBe(409);
      expect(state.write).not.toHaveBeenCalled();
    },
  );
});
