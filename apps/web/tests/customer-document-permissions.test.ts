import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  allowed: false,
  archive: vi.fn(),
  commit: vi.fn(),
  discard: vi.fn(),
  markAvailable: vi.fn(),
  metadata: vi.fn(),
  read: vi.fn(),
  register: vi.fn(),
  stage: vi.fn(),
  permissions: [] as string[],
}));

vi.mock("@or-on/auth", () => ({
  isAuthorized: () => state.allowed,
}));
vi.mock("@or-on/crm", () => ({
  archiveCustomerDocument: state.archive,
  getCustomerDocumentObjectMetadata: state.metadata,
  markCustomerDocumentAvailable: state.markAvailable,
  registerCustomerDocument: state.register,
}));
vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  withCurrentTenant: async (
    permission: string,
    operation: (
      sql: unknown,
      session: {
        userId: string;
        tenant: { tenantId: string; role: string };
        isSuperuser: boolean;
      },
    ) => Promise<unknown>,
  ) => {
    state.permissions.push(permission);
    return operation(
      {},
      {
        userId: "90000000-0000-4000-8000-000000000001",
        tenant: {
          tenantId: "80000000-0000-4000-8000-000000000001",
          role: "agent",
        },
        isSuperuser: false,
      },
    );
  },
}));
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: vi.fn(),
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      {
        status:
          error instanceof Error && error.constructor.name === "ForbiddenError"
            ? 403
            : 400,
      },
    ),
}));
vi.mock("../src/features/private-objects", () => ({
  commitPrivateObject: state.commit,
  discardPrivateObject: state.discard,
  readPrivateObject: state.read,
  stagePrivateObject: state.stage,
}));
vi.mock("../src/features/field-service", () => ({
  optionalText: (value: unknown) =>
    typeof value === "string" && value !== "" ? value : undefined,
  uuid: (value: unknown) => String(value),
}));

import { POST as uploadDocument } from "../src/app/api/crm/contacts/[id]/documents/route";
import { GET as downloadDocument } from "../src/app/api/crm/contacts/[id]/documents/[documentId]/route";

const contactId = "10000000-0000-4000-8000-000000000001";
const documentId = "20000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id: contactId }) };
const documentContext = {
  params: Promise.resolve({ id: contactId, documentId }),
};

function uploadRequest(category: "general" | "identity") {
  const form = new FormData();
  form.set("category", category);
  form.set(
    "file",
    new File(["fixture"], "fixture.txt", { type: "text/plain" }),
  );
  return new Request(
    `http://localhost/api/crm/contacts/${contactId}/documents`,
    {
      method: "POST",
      body: form,
    },
  );
}

describe("customer document permission boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.allowed = false;
    state.permissions.length = 0;
    state.stage.mockResolvedValue({
      contentType: "text/plain",
      byteSize: 7,
      checksum: "checksum",
      storageBackend: "local",
      storageKey: "tenant/contact/object",
      stagedPath: "staged",
      finalPath: "final",
    });
    state.register.mockResolvedValue({ objectId: documentId, documentId });
    state.markAvailable.mockResolvedValue(true);
  });

  it("requires sensitive write permission for identity documents", async () => {
    const response = await uploadDocument(uploadRequest("identity"), context);

    expect(response.status).toBe(201);
    expect(state.permissions).toEqual(["customer-sensitive:write"]);
  });

  it("keeps ordinary documents on the CRM write permission", async () => {
    const response = await uploadDocument(uploadRequest("general"), context);

    expect(response.status).toBe(201);
    expect(state.permissions).toEqual(["crm:write"]);
  });

  it("denies direct identity-document download without sensitive read", async () => {
    state.metadata.mockResolvedValue({
      category: "identity",
      status: "available",
      storageBackend: "local",
      storageKey: "tenant/contact/identity",
      displayName: "identity.txt",
      byteSize: 7,
      contentType: "text/plain",
      checksum: "checksum",
    });

    const response = await downloadDocument(
      new Request("http://localhost/identity"),
      documentContext,
    );

    expect(response.status).toBe(403);
    expect(state.permissions).toEqual(["crm:read"]);
    expect(state.read).not.toHaveBeenCalled();
  });

  it("forces ordinary customer documents to download with private headers", async () => {
    state.metadata.mockResolvedValue({
      category: "general",
      status: "available",
      storageBackend: "local",
      storageKey: "tenant/contact/document",
      displayName: "service-note.pdf",
      byteSize: 4,
      contentType: "application/pdf",
      checksum: "checksum",
    });
    state.read.mockResolvedValue(Uint8Array.from([1, 2, 3, 4]));

    const response = await downloadDocument(
      new Request("http://localhost/document"),
      documentContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment;/u,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
