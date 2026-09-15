import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  archiveAgent: vi.fn(),
  archiveFlow: vi.fn(),
  defaultAgent: vi.fn(),
  guard: vi.fn(),
  permission: vi.fn(),
  renameAgent: vi.fn(),
  renameFlow: vi.fn(),
  saveFlow: vi.fn(),
}));

vi.mock("@or-on/crm", () => ({
  archiveAgentProfile: state.archiveAgent,
  archiveAutomation: state.archiveFlow,
  renameAgentProfile: state.renameAgent,
  renameAutomation: state.renameFlow,
  saveCanonicalFlowDraft: state.saveFlow,
  setDefaultWhatsAppAgent: state.defaultAgent,
}));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  withCurrentTenant: (
    permission: string,
    operation: (sql: never, session: { userId: string }) => unknown,
  ) => {
    state.permission(permission);
    return operation({} as never, { userId: "user-1" });
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.guard,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "refused" },
      { status: 400 },
    ),
}));

import {
  DELETE as deleteAgent,
  PATCH as patchAgent,
} from "../src/app/api/orchestration/agents/[id]/route";
import {
  DELETE as deleteFlow,
  PATCH as patchFlow,
} from "../src/app/api/orchestration/flows/[id]/route";

const context = { params: Promise.resolve({ id: "definition-1" }) };

describe("agent and flow management APIs", () => {
  beforeEach(() => {
    for (const mock of Object.values(state)) mock.mockReset();
    state.guard.mockResolvedValue(undefined);
    state.renameAgent.mockResolvedValue(true);
    state.defaultAgent.mockResolvedValue(true);
    state.archiveAgent.mockResolvedValue("archived");
    state.renameFlow.mockResolvedValue(true);
    state.saveFlow.mockResolvedValue({ version: 2, versionId: "version-2" });
    state.archiveFlow.mockResolvedValue(true);
  });

  it("renames and selects the default agent behind flow-management RBAC", async () => {
    const rename = await patchAgent(
      new Request("http://localhost/api/orchestration/agents/definition-1", {
        method: "PATCH",
        body: JSON.stringify({ name: "AI Agent" }),
      }),
      context,
    );
    expect(rename.status).toBe(200);
    expect(state.renameAgent).toHaveBeenCalledWith(
      {},
      "user-1",
      "definition-1",
      "AI Agent",
    );

    const selected = await patchAgent(
      new Request("http://localhost/api/orchestration/agents/definition-1", {
        method: "PATCH",
        body: JSON.stringify({ defaultWhatsApp: true }),
      }),
      context,
    );
    expect(selected.status).toBe(200);
    expect(state.defaultAgent).toHaveBeenCalledWith(
      {},
      "user-1",
      "definition-1",
    );
    expect(state.permission).toHaveBeenCalledWith("flows:manage");
  });

  it("refuses to archive an agent while it owns active AI conversations", async () => {
    state.archiveAgent.mockResolvedValue("active");
    const response = await deleteAgent(
      new Request("http://localhost/api/orchestration/agents/definition-1", {
        method: "DELETE",
      }),
      context,
    );
    expect(response.status).toBe(409);
  });

  it("renames and archives flows without deleting retained versions", async () => {
    const renamed = await patchFlow(
      new Request("http://localhost/api/orchestration/flows/definition-1", {
        method: "PATCH",
        body: JSON.stringify({ name: "Customer follow-up" }),
      }),
      context,
    );
    expect(renamed.status).toBe(200);
    expect(state.renameFlow).toHaveBeenCalledWith(
      {},
      "user-1",
      "definition-1",
      "Customer follow-up",
    );

    const archived = await deleteFlow(
      new Request("http://localhost/api/orchestration/flows/definition-1", {
        method: "DELETE",
      }),
      context,
    );
    expect(archived.status).toBe(200);
    expect(state.archiveFlow).toHaveBeenCalledWith(
      {},
      "user-1",
      "definition-1",
    );
  });

  it("saves a canonical edit as a new draft behind mutation and flow-management guards", async () => {
    const flow = {
      schemaVersion: "1.0",
      channels: ["whatsapp"],
      nodes: [
        { id: "start", type: "start" },
        { id: "end", type: "end" },
      ],
      edges: [{ id: "next", source: "start", target: "end" }],
    };
    const response = await patchFlow(
      new Request("http://localhost/api/orchestration/flows/definition-1", {
        method: "PATCH",
        body: JSON.stringify({ flow }),
      }),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      version: 2,
      versionId: "version-2",
    });
    expect(state.guard).toHaveBeenCalledTimes(1);
    expect(state.permission).toHaveBeenCalledWith("flows:manage");
    expect(state.saveFlow).toHaveBeenCalledWith(
      {},
      "user-1",
      "definition-1",
      flow,
    );
  });

  it("rejects a malformed flow edit before entering the tenant transaction", async () => {
    const response = await patchFlow(
      new Request("http://localhost/api/orchestration/flows/definition-1", {
        method: "PATCH",
        body: JSON.stringify({ flow: "not-an-object" }),
      }),
      context,
    );
    expect(response.status).toBe(400);
    expect(state.saveFlow).not.toHaveBeenCalled();
    expect(state.permission).not.toHaveBeenCalled();
  });
});
