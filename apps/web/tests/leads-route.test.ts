import { afterEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  listLeads: vi.fn(),
  countLeads: vi.fn(),
  getLeadDetail: vi.fn(),
  updateLeadForOperator: vi.fn(),
  operatorLeadBinding: vi.fn(),
  saveLeadFields: vi.fn(),
  requireTenantFeature: vi.fn().mockResolvedValue(undefined),
  assertCrmMutation: vi.fn().mockResolvedValue(undefined),
}));

class LeadWorkspaceConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super("lead was modified by another writer");
    this.name = "LeadWorkspaceConflictError";
    this.currentRevision = currentRevision;
  }
}

class LeadRevisionConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super("lead was modified by another writer");
    this.name = "LeadRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

class LeadFieldValidationError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.name = "LeadFieldValidationError";
    this.field = field;
  }
}

vi.mock("@or-on/crm", () => ({
  countLeads: dependencies.countLeads,
  getLeadDetail: dependencies.getLeadDetail,
  leadFieldStates: ["known", "unknown", "declined", "not_applicable"],
  leadSortKeys: ["updated", "created", "due"],
  leadSourceChannels: ["voice", "whatsapp", "manual", "api"],
  leadStatuses: [
    "new",
    "collecting",
    "ready_for_review",
    "qualified",
    "disqualified",
    "converted",
    "archived",
  ],
  listLeads: dependencies.listLeads,
  operatorLeadBinding: dependencies.operatorLeadBinding,
  operatorLeadStatuses: [
    "new",
    "collecting",
    "ready_for_review",
    "qualified",
    "disqualified",
    "archived",
  ],
  saveLeadFields: dependencies.saveLeadFields,
  requireTenantFeature: dependencies.requireTenantFeature,
  updateLeadForOperator: dependencies.updateLeadForOperator,
  LeadFieldValidationError,
  LeadNotFoundError: class LeadNotFoundError extends Error {},
  LeadRevisionConflictError,
  LeadWorkspaceConflictError,
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

const { GET } = await import("../src/app/api/leads/route");
const detailRoute = await import("../src/app/api/leads/[id]/route");
const fieldsRoute = await import("../src/app/api/leads/[id]/fields/route");

const leadId = "55555555-5555-4555-8555-555555555555";

function listRequest(query: string) {
  return new Request(`http://localhost/api/leads?${query}`);
}

function context(id = leadId) {
  return { params: Promise.resolve({ id }) } as never;
}

function patch(body: unknown, path = "") {
  return new Request(`http://localhost/api/leads/${leadId}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("leads register API", () => {
  afterEach(() => {
    vi.clearAllMocks();
    permissions.length = 0;
  });

  it("counts the same set it lists", async () => {
    dependencies.listLeads.mockResolvedValue({ leads: [], nextCursor: null });
    dependencies.countLeads.mockResolvedValue({ total: 0, byStatus: {} });

    const response = await GET(
      listRequest(
        "status=qualified&channel=whatsapp&ownerUserId=abc&q=roni&limit=10&beforeSortAt=2026-01-01T00%3A00%3A00Z&beforeId=x",
      ),
    );

    expect(response.status).toBe(200);
    const listed = dependencies.listLeads.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    const counted = dependencies.countLeads.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    // Paging arguments are the only legitimate difference between the two: a
    // count that applied a different filter would describe a different set.
    const { limit, beforeSortAt, beforeId, ...filter } = listed;
    expect(limit).toBe(10);
    expect(beforeSortAt).toBe("2026-01-01T00:00:00Z");
    expect(beforeId).toBe("x");
    expect(filter).toEqual(counted);
    expect(counted).toEqual({
      status: "qualified",
      sourceChannel: "whatsapp",
      ownerUserId: "abc",
      query: "roni",
    });
    expect(permissions).toEqual(["crm:read"]);
  });

  it("rejects filter values it does not recognise instead of ignoring them", async () => {
    dependencies.listLeads.mockResolvedValue({ leads: [], nextCursor: null });
    dependencies.countLeads.mockResolvedValue({ total: 0, byStatus: {} });

    for (const query of [
      "status=deleted",
      "channel=telepathy",
      "sort=whatever",
      "limit=0",
      "limit=500",
      "since=not-a-date",
    ]) {
      const response = await GET(listRequest(query));
      expect(response.status, query).toBe(400);
    }
    expect(dependencies.listLeads).not.toHaveBeenCalled();
  });

  it("caps the page size so one request cannot pull the register", async () => {
    dependencies.listLeads.mockResolvedValue({ leads: [], nextCursor: null });
    dependencies.countLeads.mockResolvedValue({ total: 0, byStatus: {} });

    expect((await GET(listRequest("limit=100"))).status).toBe(200);
    expect((await GET(listRequest("limit=101"))).status).toBe(400);
  });

  it("returns 404 rather than an empty shell for a lead in another tenant", async () => {
    dependencies.getLeadDetail.mockResolvedValue(undefined);

    const response = await detailRoute.GET(
      new Request(`http://localhost/api/leads/${leadId}`),
      context(),
    );

    expect(response.status).toBe(404);
  });

  it("writes the operator edit under the session user, never a supplied one", async () => {
    dependencies.updateLeadForOperator.mockResolvedValue({ id: leadId });

    const response = await detailRoute.PATCH(
      patch({
        status: "qualified",
        ownerUserId: null,
        expectedRevision: 4,
        actorUserId: "11111111-1111-4111-8111-111111111111",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(permissions).toEqual(["crm:write"]);
    const [, actor, id, update] = dependencies.updateLeadForOperator.mock
      .calls[0] as [unknown, string, string, Record<string, unknown>];
    expect(actor).toBe("44444444-4444-4444-8444-444444444444");
    expect(id).toBe(leadId);
    expect(update).toEqual({
      status: "qualified",
      ownerUserId: null,
      expectedRevision: 4,
    });
  });

  it("refuses a status the conversion action owns", async () => {
    const response = await detailRoute.PATCH(
      patch({ status: "converted" }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(dependencies.updateLeadForOperator).not.toHaveBeenCalled();
  });

  it("reports a losing edit with the revision to reconcile against", async () => {
    dependencies.updateLeadForOperator.mockRejectedValue(
      new LeadWorkspaceConflictError(9),
    );

    const response = await detailRoute.PATCH(
      patch({ status: "qualified", expectedRevision: 4 }),
      context(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ currentRevision: 9 });
  });

  it("records a typed correction as verified by a person", async () => {
    dependencies.operatorLeadBinding.mockResolvedValue({
      contactId: "66666666-6666-4666-8666-666666666666",
      sourceChannel: "manual",
      capabilities: ["lead.read", "lead.write"],
      actorUserId: "44444444-4444-4444-8444-444444444444",
      recordedBy: "human",
    });
    dependencies.saveLeadFields.mockResolvedValue({
      receipt: { leadId, revision: 5 },
      lead: {},
      rejected: [],
    });

    const response = await fieldsRoute.PATCH(
      patch(
        {
          fields: [
            { key: "company", state: "known", value: "Fictional Systems" },
            // A caller cannot downgrade its own correction to "unconfirmed" to
            // slip past the human-verified precedence rule, nor upgrade one.
            {
              key: "budget",
              state: "known",
              value: "50000",
              confirmation: "unconfirmed",
            },
          ],
          expectedRevision: 4,
          operationKey: "lead-operator-fixture-1",
        },
        "/fields",
      ),
      context(),
    );

    expect(response.status).toBe(200);
    const [, binding, input] = dependencies.saveLeadFields.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(binding.recordedBy).toBe("human");
    expect(binding.contactId).toBe("66666666-6666-4666-8666-666666666666");
    expect(input.operationKey).toBe("lead-operator-fixture-1");
    expect(input.expectedRevision).toBe(4);
    expect(input.observations).toEqual([
      {
        key: "company",
        state: "known",
        value: "Fictional Systems",
        confirmation: "human_verified",
      },
      {
        key: "budget",
        state: "known",
        value: "50000",
        confirmation: "human_verified",
      },
    ]);
  });

  it("rejects a field the reviewed schema does not define", async () => {
    dependencies.operatorLeadBinding.mockResolvedValue({});
    dependencies.saveLeadFields.mockRejectedValue(
      new LeadFieldValidationError("national_id", "is not part of this schema"),
    );

    const response = await fieldsRoute.PATCH(
      patch(
        { fields: [{ key: "national_id", state: "known", value: "123" }] },
        "/fields",
      ),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "national_id" });
  });

  it("refuses an unsupported field state rather than storing it", async () => {
    const response = await fieldsRoute.PATCH(
      patch(
        { fields: [{ key: "company", state: "probably", value: "x" }] },
        "/fields",
      ),
      context(),
    );

    expect(response.status).toBe(400);
    expect(dependencies.saveLeadFields).not.toHaveBeenCalled();
  });
});
