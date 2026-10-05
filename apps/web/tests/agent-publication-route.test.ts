import type * as CrmModule from "@or-on/crm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  publish: vi.fn(),
  guard: vi.fn(),
  permission: vi.fn(),
}));
vi.mock("@or-on/crm", async (importOriginal) => ({
  ...(await importOriginal<typeof CrmModule>()),
  publishAgentProfile: state.publish,
}));
vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  assertAuthenticatedMutation: state.guard,
  withFreshCurrentTenant: async (
    permission: string,
    operation: (sql: never, session: { userId: string }) => Promise<unknown>,
  ) => {
    state.permission(permission);
    return operation({} as never, { userId: "fictional-owner" });
  },
}));

import { AgentProfileVersionConflictError } from "@or-on/crm";
import { ForbiddenError } from "../src/features/auth";
import { POST } from "../src/app/api/orchestration/agents/[id]/publish/route";

const profile = "11111111-1111-4111-8111-111111111111";
const version = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const context = { params: Promise.resolve({ id: profile }) };
function request(body?: string) {
  return new Request(
    `http://localhost/api/orchestration/agents/${profile}/publish`,
    {
      method: "POST",
      ...(body === undefined ? {} : { body }),
    },
  );
}

describe("reviewed agent publication route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.guard.mockResolvedValue(undefined);
    state.publish.mockResolvedValue(true);
  });

  it.each([undefined, "", "{}"])(
    "preserves legacy body compatibility (%s)",
    async (body) => {
      const response = await POST(request(body), context);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ published: true });
      expect(state.publish).toHaveBeenCalledWith(
        {},
        "fictional-owner",
        profile,
        undefined,
      );
    },
  );

  it("validates and passes the reviewed version into the fresh authorized transaction", async () => {
    const response = await POST(
      request(JSON.stringify({ expectedVersionId: version.toUpperCase() })),
      context,
    );
    expect(response.status).toBe(200);
    expect(state.guard).toHaveBeenCalledTimes(1);
    expect(state.permission).toHaveBeenCalledWith("flows:manage");
    expect(state.publish).toHaveBeenCalledWith(
      {},
      "fictional-owner",
      profile,
      version,
    );
  });

  it.each([
    "null",
    "[]",
    '"text"',
    "{",
    '{"expectedVersionId":null}',
    '{"expectedVersionId":7}',
    '{"expectedVersionId":""}',
    '{"expectedVersionId":"not-a-uuid"}',
  ])(
    "rejects malformed publication input before DB work (%s)",
    async (body) => {
      const response = await POST(request(body), context);
      expect(response.status).toBe(400);
      expect(state.permission).not.toHaveBeenCalled();
      expect(state.publish).not.toHaveBeenCalled();
    },
  );

  it("returns a stable conflict without leaking the current or foreign version", async () => {
    state.publish.mockRejectedValueOnce(new AgentProfileVersionConflictError());
    const response = await POST(
      request(JSON.stringify({ expectedVersionId: version })),
      context,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Agent version changed; refresh before publishing",
      code: "AGENT_VERSION_CHANGED",
    });
  });

  it("retains invalid-draft rejection", async () => {
    state.publish.mockResolvedValueOnce(false);
    expect((await POST(request(), context)).status).toBe(400);
  });

  it("checks the mutation boundary before parsing or publication", async () => {
    state.guard.mockRejectedValueOnce(new ForbiddenError());
    expect((await POST(request("{"), context)).status).toBe(403);
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.permission).not.toHaveBeenCalled();
  });
});
