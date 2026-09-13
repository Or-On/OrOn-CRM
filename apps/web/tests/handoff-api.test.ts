import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HandoffSummary } from "@or-on/crm";

const boundary = vi.hoisted(() => ({
  assertMutation: vi.fn(),
  parseBody: vi.fn<(request: Request) => Promise<unknown>>(),
  permission: vi.fn(),
  permissionError: null as Error | null,
  requestHandoff: vi.fn(),
  sql: {},
}));

vi.mock("@or-on/crm", () => ({
  listHandoffs: vi.fn(),
  requestHandoff: boundary.requestHandoff,
  supportedChannels: ["voice", "whatsapp"],
}));
vi.mock("../src/features/auth", () => ({
  assertAuthenticatedMutation: boundary.assertMutation,
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  jsonObject: boundary.parseBody,
  withCurrentTenant: (
    permission: string,
    operation: (sql: unknown, session: { userId: string }) => unknown,
  ) => {
    boundary.permission(permission);
    if (boundary.permissionError) throw boundary.permissionError;
    return operation(boundary.sql, {
      userId: "20000000-0000-4000-8000-000000000001",
    });
  },
}));

import { POST } from "../src/app/api/orchestration/handoffs/route";
import { ForbiddenError, UnauthenticatedError } from "../src/features/auth";

const actorId = "20000000-0000-4000-8000-000000000001";
const contactId = "30000000-0000-4000-8000-000000000001";
const handoff: HandoffSummary = {
  id: "40000000-0000-4000-8000-000000000001",
  contactId,
  sourceChannel: "whatsapp",
  reasonSafe: "Fictional customer requested operator review",
  status: "pending",
  assignedUserId: null,
  requestedAt: "2026-09-12T12:00:00.000Z",
};
const validBody = {
  contactId,
  sourceChannel: "whatsapp",
  reasonSafe: handoff.reasonSafe,
};

function request(
  body: unknown = validBody,
  idempotencyKey: string | null = "handoff:fixture-001",
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (idempotencyKey !== null) headers.set("idempotency-key", idempotencyKey);
  return new Request("http://localhost/api/orchestration/handoffs", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  boundary.assertMutation.mockReset().mockResolvedValue(undefined);
  boundary.parseBody.mockReset().mockImplementation((input) => input.json());
  boundary.permission.mockReset();
  boundary.permissionError = null;
  boundary.requestHandoff.mockReset().mockResolvedValue(handoff);
});

describe("handoff request API", () => {
  it.each(["voice", "whatsapp"])(
    "forwards validated %s fields and the exact trimmed key through messaging:operate",
    async (sourceChannel) => {
      const input = request(
        { ...validBody, sourceChannel, actorId: "untrusted-client-actor" },
        "  handoff:Case-Sensitive_001  ",
      );
      const response = await POST(input);

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ handoff });
      expect(boundary.assertMutation).toHaveBeenCalledExactlyOnceWith(input);
      expect(boundary.permission).toHaveBeenCalledExactlyOnceWith(
        "messaging:operate",
      );
      expect(boundary.requestHandoff).toHaveBeenCalledExactlyOnceWith(
        boundary.sql,
        actorId,
        contactId,
        sourceChannel,
        validBody.reasonSafe,
        "handoff:Case-Sensitive_001",
      );
    },
  );

  it.each([
    ["authentication", new UnauthenticatedError("private auth detail"), 401],
    ["CSRF", new ForbiddenError("private CSRF detail"), 403],
  ] as const)(
    "rejects failed %s before parsing or accessing the tenant",
    async (_boundary, error, status) => {
      boundary.assertMutation.mockRejectedValue(error);

      const response = await POST(request());

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: status === 401 ? "Unauthenticated" : "Forbidden",
      });
      expect(boundary.parseBody).not.toHaveBeenCalled();
      expect(boundary.permission).not.toHaveBeenCalled();
      expect(boundary.requestHandoff).not.toHaveBeenCalled();
    },
  );

  it("rejects a tenant actor without messaging:operate before requesting a handoff", async () => {
    boundary.permissionError = new ForbiddenError("private permission detail");

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(boundary.permission).toHaveBeenCalledExactlyOnceWith(
      "messaging:operate",
    );
    expect(boundary.requestHandoff).not.toHaveBeenCalled();
  });

  it.each([
    ["missing contact", { ...validBody, contactId: undefined }],
    ["non-string contact", { ...validBody, contactId: 123 }],
    ["missing channel", { ...validBody, sourceChannel: undefined }],
    ["non-string channel", { ...validBody, sourceChannel: false }],
    ["unsupported channel", { ...validBody, sourceChannel: "email" }],
    ["missing reason", { ...validBody, reasonSafe: undefined }],
    ["non-string reason", { ...validBody, reasonSafe: { text: "review" } }],
  ])("rejects %s before the tenant write", async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "valid contact, channel, and reason are required",
    });
    expect(boundary.permission).not.toHaveBeenCalled();
    expect(boundary.requestHandoff).not.toHaveBeenCalled();
  });

  it.each([null, "   "])(
    "requires a nonblank idempotency header (%s)",
    async (idempotencyKey) => {
      const response = await POST(request(validBody, idempotencyKey));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "idempotency-key is required",
      });
      expect(boundary.permission).not.toHaveBeenCalled();
      expect(boundary.requestHandoff).not.toHaveBeenCalled();
    },
  );

  it("returns the existing durable receipt supplied by CRM on an exact replay", async () => {
    const first = await POST(request());
    const replay = await POST(request());

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await first.json()).toEqual({ handoff });
    expect(await replay.json()).toEqual({ handoff });
    expect(boundary.requestHandoff).toHaveBeenCalledTimes(2);
    expect(boundary.requestHandoff.mock.calls[0]).toEqual(
      boundary.requestHandoff.mock.calls[1],
    );
  });

  it("maps changed-parameter idempotency conflicts to sanitized 409 without a fabricated receipt", async () => {
    boundary.requestHandoff.mockRejectedValue(
      Object.assign(new Error("private conflicting request contents"), {
        code: "23505",
        detail: "private existing handoff contents",
      }),
    );

    const response = await POST(
      request({ ...validBody, reasonSafe: "Changed fictional reason" }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "A matching record already exists",
    });
    expect(boundary.requestHandoff).toHaveBeenCalledExactlyOnceWith(
      boundary.sql,
      actorId,
      contactId,
      "whatsapp",
      "Changed fictional reason",
      "handoff:fixture-001",
    );
  });
});
