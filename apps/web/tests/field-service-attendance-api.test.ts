import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  begin: vi.fn(),
  commit: vi.fn(),
  discard: vi.fn(),
  link: vi.fn(),
  mark: vi.fn(),
  register: vi.fn(),
  sign: vi.fn(),
  stage: vi.fn(),
  order: [] as string[],
}));

vi.mock("@or-on/crm", () => ({
  beginVisitAttendanceRequest: state.begin,
  linkReportAttachment: (...arguments_: unknown[]) => {
    state.order.push("link");
    return state.link(...arguments_) as unknown;
  },
  markFieldServiceObjectAvailable: (...arguments_: unknown[]) => {
    state.order.push("available");
    return state.mark(...arguments_) as unknown;
  },
  registerFieldServiceObject: (...arguments_: unknown[]) => {
    state.order.push("register");
    return state.register(...arguments_) as unknown;
  },
  signVisitAttendance: (...arguments_: unknown[]) => {
    state.order.push("sign");
    return state.sign(...arguments_) as unknown;
  },
}));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  requestId: () => "generated-request-key",
  withCurrentTenant: async (
    permission: string,
    operation: (
      sql: unknown,
      session: {
        userId: string;
        sessionId: string;
        tenant: { tenantId: string };
      },
    ) => Promise<unknown>,
  ) => {
    expect(permission).toBe("field-service:operate");
    return operation(
      {},
      {
        userId: "90000000-0000-4000-8000-000000000001",
        sessionId: "80000000-0000-4000-8000-000000000001",
        tenant: { tenantId: "70000000-0000-4000-8000-000000000001" },
      },
    );
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: vi.fn(),
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    ),
}));
vi.mock("../src/features/private-objects", () => ({
  commitPrivateObject: (...arguments_: unknown[]) => {
    state.order.push("commit");
    return state.commit(...arguments_) as unknown;
  },
  discardPrivateObject: state.discard,
  stagePrivateObject: (...arguments_: unknown[]) => {
    state.order.push("stage");
    return state.stage(...arguments_) as unknown;
  },
}));
vi.mock("../src/features/field-service", () => ({
  uuid: (value: unknown) => String(value),
}));

import { POST } from "../src/app/api/field-service/visits/[id]/attendance/route";

const visitId = "10000000-0000-4000-8000-000000000001";
const caseId = "20000000-0000-4000-8000-000000000001";
const objectId = "30000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: visitId }) };

function request() {
  const form = new FormData();
  form.set("kind", "arrival");
  form.set("caseId", caseId);
  form.set(
    "file",
    new File(["signature"], "arrival.png", { type: "image/png" }),
  );
  return new Request(
    `http://localhost/api/field-service/visits/${visitId}/attendance`,
    {
      method: "POST",
      headers: { "idempotency-key": "attendance-test-request" },
      body: form,
    },
  );
}

describe("atomic field-service attendance evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.order.length = 0;
    state.begin.mockResolvedValue(undefined);
    state.stage.mockResolvedValue({
      contentType: "image/png",
      byteSize: 9,
      checksum: "checksum",
      storageBackend: "local",
      storageKey: "tenant/case/arrival.png",
      stagedPath: "staged",
      finalPath: "final",
    });
    state.register.mockResolvedValue(objectId);
    state.mark.mockResolvedValue(true);
    state.link.mockResolvedValue(undefined);
    state.discard.mockResolvedValue(undefined);
    state.sign.mockResolvedValue({
      id: visitId,
      arrivalSignatureObjectId: objectId,
      departureSignatureObjectId: null,
    });
  });

  it("promotes, links, and signs one evidence object in order", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(201);
    expect(state.order).toEqual([
      "stage",
      "register",
      "commit",
      "available",
      "link",
      "sign",
    ]);
    expect(state.sign).toHaveBeenCalledWith(
      {},
      {
        visitId,
        signatureObjectId: objectId,
        kind: "arrival",
        requestId: "attendance-test-request",
      },
    );
    expect(state.discard).not.toHaveBeenCalled();
  });

  it("reconciles a completed retry before creating another object", async () => {
    state.begin.mockResolvedValue({
      id: visitId,
      arrivalSignatureObjectId: objectId,
      departureSignatureObjectId: null,
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(state.stage).not.toHaveBeenCalled();
    expect(state.sign).not.toHaveBeenCalled();
  });

  it("removes staged and promoted files when the attendance transaction fails", async () => {
    state.sign.mockRejectedValue(new Error("synthetic signing failure"));

    const response = await POST(request(), context);

    expect(response.status).toBe(400);
    expect(state.discard).toHaveBeenCalledTimes(1);
  });
});
