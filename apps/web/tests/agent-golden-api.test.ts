import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  authorized: true,
  csrf: vi.fn(),
  permission: vi.fn(),
  read: vi.fn(),
  request: vi.fn(),
}));
vi.mock("@or-on/crm", () => ({
  getAgentGoldenWorkspace: boundary.read,
  requestAgentGoldenEvaluation: boundary.request,
}));
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: boundary.csrf,
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: (
    permission: string,
    operation: (sql: unknown) => unknown,
  ) => {
    boundary.permission(permission);
    if (!boundary.authorized)
      throw Object.assign(Error("Forbidden"), { code: "42501" });
    return operation({});
  },
  withFreshCurrentTenant: (
    permission: string,
    operation: (sql: unknown) => unknown,
  ) => {
    boundary.permission(permission);
    if (!boundary.authorized)
      throw Object.assign(Error("Forbidden"), { code: "42501" });
    return operation({});
  },
}));
import {
  GET,
  POST,
} from "../src/app/api/orchestration/agents/[id]/golden-evaluations/route";

const profile = "10000000-0000-4000-8000-000000000001";
const version = "20000000-0000-4000-8000-000000000001";
const dataset = "30000000-0000-4000-8000-000000000001";
const context = () => ({ params: Promise.resolve({ id: profile }) });
const request = () =>
  new Request(
    "http://localhost/api/orchestration/agents/" +
      profile +
      "/golden-evaluations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: version, datasetId: dataset }),
    },
  );
beforeEach(() => {
  vi.clearAllMocks();
  boundary.authorized = true;
  boundary.csrf.mockResolvedValue(undefined);
  boundary.read.mockResolvedValue({
    enabled: false,
    datasets: [],
    evaluations: [],
  });
  boundary.request.mockResolvedValue("40000000-0000-4000-8000-000000000001");
});

describe("golden request/status HTTP boundaries (mocked route; PG separately)", () => {
  it("returns private uncached status with flows:manage scope and route/version binding", async () => {
    const result = await GET(
      new Request("http://localhost/golden?versionId=" + version),
      context(),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(boundary.permission).toHaveBeenCalledWith("flows:manage");
    expect(boundary.read).toHaveBeenCalledWith({}, profile, version, null);
  });
  it("passes the exact publication candidate selector to the authorized workspace", async () => {
    const operation = "50000000-0000-4000-8000-000000000001";
    const result = await GET(
      new Request(
        `http://localhost/golden?versionId=${version}&publicationOperationId=${operation}`,
      ),
      context(),
    );
    expect(result.status).toBe(200);
    expect(boundary.read).toHaveBeenCalledWith({}, profile, version, operation);
  });
  it("checks CSRF before requesting any evaluation", async () => {
    boundary.csrf.mockRejectedValue({ code: "42501" });
    expect((await POST(request(), context())).status).toBe(403);
    expect(boundary.request).not.toHaveBeenCalled();
  });
  it("denies unauthorized reads and requests, while permitted requests only return a job ID", async () => {
    boundary.authorized = false;
    expect(
      (
        await GET(
          new Request("http://localhost/golden?versionId=" + version),
          context(),
        )
      ).status,
    ).toBe(403);
    expect((await POST(request(), context())).status).toBe(403);
    expect(boundary.read).not.toHaveBeenCalled();
    expect(boundary.request).not.toHaveBeenCalled();
    boundary.authorized = true;
    const result = await POST(request(), context());
    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({
      id: "40000000-0000-4000-8000-000000000001",
    });
  });
});
