import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "technician",
  bind: vi.fn(),
  context: vi.fn(),
  contacts: vi.fn(),
  createCase: vi.fn(),
  createTechnicianCase: vi.fn(),
  release: vi.fn(),
  tenant: vi.fn(),
  fresh: vi.fn(),
}));

vi.mock("@or-on/crm", () => ({
  bindTechnicianSession: state.bind,
  createServiceCase: state.createCase,
  createTechnicianServiceCase: state.createTechnicianCase,
  getTechnicianSessionContext: state.context,
  listContacts: state.contacts,
  listServiceCasePage: vi.fn(),
  releaseTechnicianSession: state.release,
  requireFieldService: () => Promise.resolve({}),
  serviceCaseStatuses: [
    "awaiting_scheduling",
    "scheduled",
    "in_progress",
    "completed",
    "closed",
    "cancelled",
  ],
}));
vi.mock("../src/features/auth", () => ({
  jsonObject: (request: Request) => request.json(),
  requestId: () => "technician-request",
  withCurrentTenant: state.tenant,
  withFreshCurrentTenant: state.fresh,
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: vi.fn(),
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: error instanceof TypeError ? 400 : 500 },
    ),
}));
vi.mock("../src/features/field-service", async () => {
  const values = await import("../src/features/field-service/request-values");
  return { ...values };
});

import { POST as createCase } from "../src/app/api/field-service/cases/route";
import { GET as customers } from "../src/app/api/field-service/customers/route";
import {
  DELETE as releaseTechnician,
  GET as sessionTechnician,
  POST as identifyTechnician,
} from "../src/app/api/field-service/session-technician/route";

const customerContactId = "10000000-0000-4000-8000-000000000001";
const technicianId = "20000000-0000-4000-8000-000000000001";
const caseId = "30000000-0000-4000-8000-000000000001";
const visitId = "40000000-0000-4000-8000-000000000001";

function caseRequest(body: Record<string, unknown>) {
  return new Request("https://example.invalid/api/field-service/cases", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("technician field-service API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.role = "technician";
    const session = () => ({
      userId: "50000000-0000-4000-8000-000000000001",
      isSuperuser: false,
      tenant: { role: state.role },
    });
    state.tenant.mockImplementation(
      async (
        _permission: string,
        work: (sql: unknown, current: unknown) => Promise<unknown>,
      ) => work({}, session()),
    );
    state.fresh.mockImplementation(
      async (
        _permission: string,
        work: (sql: unknown, current: unknown) => Promise<unknown>,
      ) => work({}, session()),
    );
    state.createTechnicianCase.mockResolvedValue({
      serviceCase: { id: caseId, reference: "FS-2026-ABCDEF12" },
      technicianId,
      visitId,
    });
    state.createCase.mockResolvedValue({ id: caseId });
  });

  it("creates a technician case through the session-bound repository path", async () => {
    const response = await createCase(
      caseRequest({
        customerContactId,
        title: "Checkout printer is blank",
        faultDescription: "Receipts print blank",
        exactFailure: "Only the header prints",
        productModel: "Fictional printer",
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      case: { id: caseId, reference: "FS-2026-ABCDEF12" },
      technicianId,
      visitId,
    });
    expect(state.tenant).toHaveBeenCalledWith(
      "field-service:operate",
      expect.any(Function),
    );
    expect(state.createTechnicianCase).toHaveBeenCalledWith(
      {},
      {
        customerContactId,
        title: "Checkout printer is blank",
        faultDescription: "Receipts print blank",
        exactFailure: "Only the header prints",
        warrantyStatus: "unknown",
        productModel: "Fictional printer",
        priority: "normal",
        requestId: "technician-request",
      },
    );
    expect(state.createCase).not.toHaveBeenCalled();
  });

  it.each(["technicianId", "assignedTechnicianId", "reportingContactId"])(
    "refuses a browser-chosen %s on a technician case",
    async (field) => {
      const response = await createCase(
        caseRequest({
          customerContactId,
          title: "Scale does not tare",
          faultDescription: "Scale drifts",
          [field]: technicianId,
        }),
      );

      expect(response.status).toBe(400);
      expect(state.createTechnicianCase).not.toHaveBeenCalled();
      expect(state.createCase).not.toHaveBeenCalled();
    },
  );

  it("keeps manager case creation on the existing path", async () => {
    state.role = "owner";
    const response = await createCase(
      caseRequest({
        customerContactId,
        title: "Fridge is warm",
        faultDescription: "Temperature drifts",
        reportingContactId: customerContactId,
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ case: { id: caseId } });
    expect(state.createTechnicianCase).not.toHaveBeenCalled();
    expect(state.createCase).toHaveBeenCalledWith(
      {},
      { userId: "50000000-0000-4000-8000-000000000001" },
      expect.objectContaining({
        customerContactId,
        reportingContactId: customerContactId,
        title: "Fridge is warm",
      }),
    );
  });

  it("reports this session's technician without exposing other technicians", async () => {
    state.context.mockResolvedValue({ mode: "shared", technician: null });
    const unidentified = await sessionTechnician();
    expect(unidentified.headers.get("cache-control")).toBe("private, no-store");
    expect(await unidentified.json()).toEqual({
      mode: "shared",
      technician: null,
    });

    state.context.mockResolvedValue({
      mode: "shared",
      technician: {
        id: technicianId,
        fullName: "David Fixture",
        identityVerification: "self_declared",
      },
    });
    expect(await (await sessionTechnician()).json()).toEqual({
      mode: "shared",
      technician: {
        id: technicianId,
        fullName: "David Fixture",
        identityVerification: "self_declared",
      },
    });
  });

  it("binds the typed details to this session and refuses a caller-chosen technician", async () => {
    state.bind.mockResolvedValue({
      id: technicianId,
      fullName: "David Fixture",
      identityVerification: "self_declared",
    });
    const identify = (body: Record<string, unknown>) =>
      identifyTechnician(
        new Request(
          "https://example.invalid/api/field-service/session-technician",
          { method: "POST", body: JSON.stringify(body) },
        ),
      );

    const response = await identify({
      fullName: "David Fixture",
      employeeIdentifier: "FS-DAVID",
      phone: "+972500000000",
    });

    expect(response.status).toBe(200);
    expect(state.fresh).toHaveBeenCalledWith(
      "field-service:operate",
      expect.any(Function),
    );
    expect(state.bind).toHaveBeenCalledWith(
      {},
      {
        fullName: "David Fixture",
        employeeIdentifier: "FS-DAVID",
        phone: "+972500000000",
        requestId: "technician-request",
      },
    );

    for (const forbidden of [
      { technicianId },
      { sessionId: "60000000-0000-4000-8000-000000000001" },
      { userId: "70000000-0000-4000-8000-000000000001" },
      { tenantId: "80000000-0000-4000-8000-000000000001" },
    ]) {
      const refused = await identify({
        fullName: "David Fixture",
        employeeIdentifier: "FS-DAVID",
        ...forbidden,
      });
      expect(refused.status).toBe(400);
    }
    expect(state.bind).toHaveBeenCalledOnce();
  });

  it("releases this session's technician for a device handover", async () => {
    state.release.mockResolvedValue(true);
    const response = await releaseTechnician(
      new Request(
        "https://example.invalid/api/field-service/session-technician",
        { method: "DELETE" },
      ),
    );

    expect(await response.json()).toEqual({ released: true });
    expect(state.release).toHaveBeenCalledWith({}, "technician-request");
  });

  it("returns only case-form customer fields to a technician", async () => {
    state.contacts.mockResolvedValue([
      {
        id: customerContactId,
        name: "Fictional customer",
        company: "Fictional chain",
        email: "customer@example.invalid",
        identities: [{ normalizedValue: "+972500000000" }],
        voiceConsent: "granted",
      },
    ]);
    const response = await customers(
      new Request("https://example.invalid/api/field-service/customers?q=fict"),
    );

    expect(await response.json()).toEqual({
      contacts: [
        {
          id: customerContactId,
          name: "Fictional customer",
          company: "Fictional chain",
        },
      ],
    });
    expect(state.contacts).toHaveBeenCalledWith(
      {},
      { query: "fict", limit: 50 },
    );
    expect(state.tenant).toHaveBeenCalledWith(
      "field-service:operate",
      expect.any(Function),
    );
  });
});
