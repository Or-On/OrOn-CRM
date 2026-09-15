import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assertMutation: vi.fn(),
  dossier: vi.fn(),
  linkCall: vi.fn(),
  linkConversation: vi.fn(),
  linkCandidates: vi.fn(),
  permissions: [] as string[],
  voiceAllowed: false,
}));

vi.mock("@or-on/auth", () => ({
  isAuthorized: () => state.voiceAllowed,
}));
vi.mock("@or-on/crm", () => ({
  getServiceCaseDossier: state.dossier,
  linkCaseCall: state.linkCall,
  linkCaseConversation: state.linkConversation,
  listServiceCaseLinkCandidates: state.linkCandidates,
  serviceCaseStatuses: ["scheduled"],
  transitionServiceCase: vi.fn(),
}));
vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ForbiddenError";
    }
  },
  jsonObject: (request: Request) => request.json(),
  requestId: () => "field-service-permission-test",
  withCurrentTenant: async (
    permission: string,
    operation: (
      sql: unknown,
      session: {
        userId: string;
        tenant: { role: string };
        isSuperuser: boolean;
      },
    ) => Promise<unknown>,
  ) => {
    state.permissions.push(permission);
    return operation(
      {},
      {
        userId: "90000000-0000-4000-8000-000000000001",
        tenant: { role: "admin" },
        isSuperuser: false,
      },
    );
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.assertMutation,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      {
        status:
          error instanceof Error && error.name === "ForbiddenError" ? 403 : 400,
      },
    ),
}));

import { GET as getCase } from "../src/app/api/field-service/cases/[id]/route";
import {
  GET as getLinkCandidates,
  POST as linkEvidence,
} from "../src/app/api/field-service/cases/[id]/links/route";

const caseId = "10000000-0000-4000-8000-000000000001";
const sourceId = "20000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: caseId }) };
const callEvidence = {
  sessionId: sourceId,
  status: "ended",
  direction: "outbound",
  outcome: "completed",
  answered: true,
  startedAt: "2026-09-15T08:00:00.000Z",
  endedAt: "2026-09-15T08:01:00.000Z",
  recordingObjectId: "30000000-0000-4000-8000-000000000001",
  transcriptObjectId: "40000000-0000-4000-8000-000000000001",
  recordingStatus: "available",
  transcriptStatus: "available",
};

function request(sourceKind: "call" | "conversation") {
  return new Request(
    `http://localhost/api/field-service/cases/${caseId}/links`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceKind, sourceId }),
    },
  );
}

describe("field-service voice permission boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions.length = 0;
    state.voiceAllowed = false;
    state.assertMutation.mockResolvedValue(undefined);
    state.dossier.mockResolvedValue({
      callSessionIds: [sourceId],
      calls: [callEvidence],
      summaries: [
        { sourceKind: "call", status: "completed", summary: "Private call" },
        {
          sourceKind: "whatsapp",
          status: "completed",
          summary: "Visible chat",
        },
      ],
    });
    state.linkCandidates.mockResolvedValue({
      conversations: [
        {
          id: sourceId,
          status: "open",
          lastMessageAt: null,
          linked: false,
          linkedCaseCount: 0,
        },
      ],
      calls: [{ ...callEvidence, linked: false, linkedCaseCount: 0 }],
    });
  });

  it("redacts call evidence from the case JSON response", async () => {
    const response = await getCase(
      new Request(`http://localhost/api/field-service/cases/${caseId}`),
      context,
    );
    const body = (await response.json()) as {
      dossier: {
        callSessionIds: string[];
        calls: unknown[];
        summaries: { sourceKind: string }[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.dossier.callSessionIds).toEqual([]);
    expect(body.dossier.calls).toEqual([]);
    expect(body.dossier.summaries).toEqual([
      expect.objectContaining({ sourceKind: "whatsapp" }),
    ]);
  });

  it("keeps conversation candidates while redacting call candidates", async () => {
    const response = await getLinkCandidates(
      new Request(`http://localhost/api/field-service/cases/${caseId}/links`),
      context,
    );
    const body = (await response.json()) as {
      candidates: { conversations: unknown[]; calls: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(body.candidates.conversations).toHaveLength(1);
    expect(body.candidates.calls).toEqual([]);
  });

  it("denies call linking but still permits conversation linking", async () => {
    const denied = await linkEvidence(request("call"), context);

    expect(denied.status).toBe(403);
    expect(state.linkCall).not.toHaveBeenCalled();

    const allowed = await linkEvidence(request("conversation"), context);

    expect(allowed.status).toBe(200);
    expect(state.linkConversation).toHaveBeenCalledOnce();
  });
});
