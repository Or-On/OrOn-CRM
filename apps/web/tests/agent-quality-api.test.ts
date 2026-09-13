import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  assertMutation: vi.fn(),
  authorized: true,
  calls: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("@or-on/crm", () => ({
  createKnowledgeDraft: boundary.create,
  listKnowledgeVersions: boundary.list,
  changeKnowledgePublication: boundary.publish,
}));
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: boundary.assertMutation,
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: (
    permission: string,
    operation: (sql: unknown) => unknown,
  ) => {
    boundary.calls(permission);
    if (!boundary.authorized)
      throw Object.assign(new Error("Forbidden"), { code: "42501" });
    return operation({});
  },
  withFreshCurrentTenant: (
    permission: string,
    operation: (sql: unknown, session: { userId: string }) => unknown,
  ) => {
    boundary.calls(permission);
    if (!boundary.authorized)
      throw Object.assign(new Error("Forbidden"), { code: "42501" });
    return operation({}, { userId: "20000000-0000-4000-8000-000000000001" });
  },
}));
import { GET, POST, PATCH } from "../src/app/api/orchestration/knowledge/route";
const request = (body: unknown) =>
  new Request("http://localhost/api/orchestration/knowledge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  boundary.authorized = true;
  boundary.assertMutation.mockResolvedValue(undefined);
  boundary.create.mockResolvedValue("created");
  boundary.list.mockResolvedValue([]);
});
describe("knowledge management API permission and mutation boundaries", () => {
  it("uses a fresh flows:manage transaction for persistence", async () => {
    expect((await POST(request({ title: "Fictional source" }))).status).toBe(
      201,
    );
    expect(boundary.assertMutation).toHaveBeenCalledOnce();
    expect(boundary.calls).toHaveBeenCalledWith("flows:manage");
    expect(boundary.create).toHaveBeenCalledOnce();
  });
  it("rejects read-only roles before reading drafts or writing content", async () => {
    boundary.authorized = false;
    expect((await GET()).status).toBe(403);
    expect((await POST(request({}))).status).toBe(403);
    expect(boundary.create).not.toHaveBeenCalled();
    expect(boundary.list).not.toHaveBeenCalled();
  });
  it("requires CSRF authentication before publication", async () => {
    boundary.assertMutation.mockRejectedValue({ code: "42501" });
    expect(
      (await PATCH(request({ documentId: "fictional", action: "publish" })))
        .status,
    ).toBe(403);
    expect(boundary.publish).not.toHaveBeenCalled();
  });
  it("rejects unsupported source lifecycle actions", async () => {
    expect(
      (await PATCH(request({ documentId: "fictional", action: "approve-all" })))
        .status,
    ).toBe(400);
    expect(boundary.publish).not.toHaveBeenCalled();
  });
});
