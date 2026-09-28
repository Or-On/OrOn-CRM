import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
  csrf: vi.fn(),
  role: "owner",
  permissions: [] as string[],
}));
vi.mock("@or-on/crm", () => ({
  listServiceInquiries: state.list,
  resolveServiceInquiry: state.resolve,
  getTenantSettings: () => Promise.resolve({ timezone: "Asia/Jerusalem" }),
}));
vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  withCurrentTenant: async (
    permission: string,
    operation: (sql: object, session: object) => unknown,
  ) => {
    state.permissions.push(permission);
    if (
      state.role === "technician" ||
      (state.role === "viewer" && permission === "field-service:manage")
    )
      throw new Error("Forbidden");
    return await operation(
      {},
      {
        userId: "20000000-0000-4000-8000-000000000001",
        tenant: { role: state.role },
        isSuperuser: false,
      },
    );
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.csrf,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: error instanceof TypeError ? 400 : 403 },
    ),
}));
import { GET } from "../src/app/api/service-inquiries/route";
import { POST } from "../src/app/api/service-inquiries/[id]/resolve/route";
const id = "10000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
function request(body: unknown) {
  return new Request(`http://localhost/api/service-inquiries/${id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  state.role = "owner";
  state.permissions = [];
  state.list.mockReset().mockResolvedValue({ inquiries: [], nextCursor: null });
  state.resolve.mockReset();
  state.csrf.mockReset().mockResolvedValue(undefined);
});
describe("service manager API boundaries", () => {
  it("uses tenant timezone and opening-date pagination", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/service-inquiries?status=scheduled&since=2026-09-01&beforeOpenedAt=2026-09-20T10:00:00Z&beforeId=${id}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(state.permissions).toEqual(["crm:read"]);
    expect(state.list).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        timezone: "Asia/Jerusalem",
        status: "scheduled",
        since: "2026-09-01",
        beforeId: id,
      }),
    );
  });
  it("does not expose the manager inquiry register to a technician", async () => {
    state.role = "technician";
    expect(
      (await GET(new Request("http://localhost/api/service-inquiries"))).status,
    ).toBe(403);
    expect(state.list).not.toHaveBeenCalled();
  });
  it("checks CSRF and manager permission before resolution", async () => {
    const body = {
      method: "telephone",
      confirmation: "customer",
      summary: "Customer confirmed repair",
    };
    expect((await POST(request(body), context)).status).toBe(200);
    expect(state.csrf).toHaveBeenCalledOnce();
    expect(state.permissions).toEqual(["field-service:manage"]);
    expect(state.resolve).toHaveBeenCalledWith(
      {},
      "20000000-0000-4000-8000-000000000001",
      { ...body, ticketId: id },
    );
  });
  it("refuses a resolution without explicit confirmation", async () => {
    expect(
      (
        await POST(
          request({
            method: "telephone",
            confirmation: "none",
            summary: "Ended call",
          }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it("rejects a malformed body without entering the tenant mutation", async () => {
    expect((await POST(request(null), context)).status).toBe(400);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.permissions).toEqual([]);
  });
  it("cannot resolve as a viewer or after a failed CSRF check", async () => {
    const body = {
      method: "technician",
      confirmation: "authoritative_evidence",
      summary: "Signed report confirms repair",
    };
    state.role = "viewer";
    expect((await POST(request(body), context)).status).toBe(403);
    expect(state.resolve).not.toHaveBeenCalled();
    state.role = "owner";
    state.csrf.mockRejectedValue(new Error("CSRF"));
    expect((await POST(request(body), context)).status).toBe(403);
    expect(state.resolve).not.toHaveBeenCalled();
  });
});
