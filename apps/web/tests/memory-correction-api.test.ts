import { beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  mutation: vi.fn(),
  tenant: vi.fn(),
  correct: vi.fn(),
}));
vi.mock("@or-on/crm", () => ({ correctCustomerMemoryFact: hooks.correct }));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: hooks.tenant,
  UnauthenticatedError: class extends Error {},
  ForbiddenError: class extends Error {},
}));
vi.mock("../src/features/crm-route", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertCrmMutation: hooks.mutation,
}));
import { PATCH } from "../src/app/api/crm/contacts/[id]/memory/route";
const context = { params: Promise.resolve({ id: "contact" }) };
const request = (body: unknown) =>
  new Request("https://example.invalid/api/crm/contacts/contact/memory", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
describe("human memory correction API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hooks.tenant.mockImplementation(
      (_permission: string, fn: (sql: unknown) => unknown) =>
        Promise.resolve(fn({})),
    );
    hooks.correct.mockResolvedValue("correction");
  });
  it("resolves authenticated crm write and returns private human correction receipt", async () => {
    const response = await PATCH(
      request({
        factId: "fact",
        value: "Corrected",
        reason: "Human correction",
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(hooks.tenant).toHaveBeenCalledWith(
      "crm:write",
      expect.any(Function),
    );
    expect(hooks.correct).toHaveBeenCalledWith(
      {},
      {
        contactId: "contact",
        factId: "fact",
        value: "Corrected",
        reason: "Human correction",
      },
    );
  });
  it.each(["tenantId", "authorId", "confidence", "passed", "approved"])(
    "rejects forged %s metadata before mutation",
    async (key) => {
      const response = await PATCH(
        request({
          factId: "fact",
          value: null,
          reason: "Delete",
          [key]: "forged",
        }),
        context,
      );
      expect(response.status).toBe(400);
      expect(hooks.correct).not.toHaveBeenCalled();
    },
  );
  it("preserves canonical database denial and omits sensitive diagnostic", async () => {
    hooks.correct.mockRejectedValue({
      code: "42501",
      message: "private reason",
    });
    const response = await PATCH(
      request({ factId: "fact", value: null, reason: "Delete" }),
      context,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });
  it("missing or mismatched scoped fact is404", async () => {
    hooks.correct.mockResolvedValue(null);
    expect(
      (
        await PATCH(
          request({ factId: "foreign", value: null, reason: "Delete" }),
          context,
        )
      ).status,
    ).toBe(404);
  });
  it("CSRF denial prevents tenant transaction", async () => {
    hooks.mutation.mockRejectedValue({ code: "42501" });
    expect(
      (
        await PATCH(
          request({ factId: "fact", value: null, reason: "Delete" }),
          context,
        )
      ).status,
    ).toBe(403);
    expect(hooks.tenant).not.toHaveBeenCalled();
  });
});
