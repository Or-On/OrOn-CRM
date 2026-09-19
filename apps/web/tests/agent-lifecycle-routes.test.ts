import { afterEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  rebindAgentConversations: vi.fn(),
  createLeadFieldSchema: vi.fn(),
  listLeadFieldSchemas: vi.fn(),
  assertCrmMutation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@or-on/crm", () => ({
  createLeadFieldSchema: dependencies.createLeadFieldSchema,
  listLeadFieldSchemas: dependencies.listLeadFieldSchemas,
  rebindAgentConversations: dependencies.rebindAgentConversations,
}));

const permissions: string[] = [];

vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: dependencies.assertCrmMutation,
  ForbiddenError: class ForbiddenError extends Error {},
  jsonObject: (request: Request) => request.json(),
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  withCurrentTenant: async (
    permission: string,
    operation: (sql: unknown, session: { userId: string }) => Promise<unknown>,
  ) => {
    permissions.push(permission);
    return operation(vi.fn(), {
      userId: "44444444-4444-4444-8444-444444444444",
    });
  },
}));

const rebind =
  await import("../src/app/api/orchestration/agents/[id]/rebind/route");
const schemas = await import("../src/app/api/leads/schemas/route");

function post(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: "agent" }) } as never;

describe("agent lifecycle routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    permissions.length = 0;
  });

  it("rebinds only to the published version the operator named", async () => {
    dependencies.rebindAgentConversations.mockResolvedValue({
      versionId: "v2",
      rebound: 2,
    });
    const response = await rebind.POST(
      post("http://localhost/api/orchestration/agents/agent/rebind", {
        versionId: "v2",
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ versionId: "v2", rebound: 2 });
    expect(permissions).toEqual(["flows:manage"]);
    expect(dependencies.rebindAgentConversations).toHaveBeenCalledWith(
      expect.anything(),
      "44444444-4444-4444-8444-444444444444",
      "agent",
      "v2",
    );
  });

  it("refuses a rebind that does not say which version it reviewed", async () => {
    const response = await rebind.POST(
      post("http://localhost/api/orchestration/agents/agent/rebind", {}),
      context,
    );
    expect(response.status).toBe(400);
    expect(dependencies.rebindAgentConversations).not.toHaveBeenCalled();
  });

  it("reports an agent with nothing published as not found", async () => {
    dependencies.rebindAgentConversations.mockResolvedValue(null);
    const response = await rebind.POST(
      post("http://localhost/api/orchestration/agents/agent/rebind", {
        versionId: "v2",
      }),
      context,
    );
    expect(response.status).toBe(404);
  });

  it("publishes a field list under the flow manager's permission", async () => {
    dependencies.createLeadFieldSchema.mockResolvedValue({
      id: "schema",
      version: 1,
    });
    const response = await schemas.POST(
      post("http://localhost/api/leads/schemas", {
        name: "Property viewing request",
        fields: [
          {
            key: "viewing_date",
            label: "Viewing date",
            type: "date",
            required: true,
          },
        ],
      }),
    );
    expect(response.status).toBe(201);
    expect(permissions).toEqual(["flows:manage"]);
    expect(dependencies.createLeadFieldSchema.mock.calls[0]?.[2]).toMatchObject(
      {
        name: "Property viewing request",
      },
    );
  });

  it("surfaces a schema the shared contract rejects as a 400", async () => {
    dependencies.createLeadFieldSchema.mockRejectedValue(
      new TypeError("lead field schema: field keys must be unique"),
    );
    const response = await schemas.POST(
      post("http://localhost/api/leads/schemas", {
        name: "Broken",
        fields: [],
      }),
    );
    expect(response.status).toBe(400);
  });

  it("lists field lists for any reader", async () => {
    dependencies.listLeadFieldSchemas.mockResolvedValue([]);
    const response = await schemas.GET();
    expect(response.status).toBe(200);
    expect(permissions).toEqual(["crm:read"]);
  });
});
