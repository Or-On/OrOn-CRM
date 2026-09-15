import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createZip: vi.fn(),
  getDocumentMetadata: vi.fn(),
  getDossier: vi.fn(),
  getEvidenceMetadata: vi.fn(),
  listArchive: vi.fn(),
  readObject: vi.fn(),
  sql: Object.assign(vi.fn(), { json: (value: unknown) => value }),
}));

vi.mock("@or-on/crm", () => ({
  createSafeZipArchive: state.createZip,
  getCustomerDocumentObjectMetadata: state.getDocumentMetadata,
  getFieldServiceObjectMetadataForArchive: state.getEvidenceMetadata,
  getServiceCaseDossierForArchive: state.getDossier,
  listServiceCasesForArchive: state.listArchive,
  safeArchiveSegment: (value: string) => value.replaceAll(" ", "_"),
}));
vi.mock("../src/features/auth", () => ({
  withCurrentTenant: (
    permission: string,
    operation: (
      sql: typeof state.sql,
      session: { readonly userId: string },
    ) => unknown,
  ) => {
    expect(permission).toBe("tenant:manage");
    return operation(state.sql, {
      userId: "90000000-0000-4000-8000-000000000001",
    });
  },
}));
vi.mock("../src/features/crm-route", () => ({
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    ),
}));
vi.mock("../src/features/field-service", () => ({
  uuid: (value: unknown) => String(value),
}));
vi.mock("../src/features/private-objects", () => ({
  readPrivateObject: state.readObject,
}));

import { GET } from "../src/app/api/settings/field-service/archive/[id]/route";
import { GET as GET_INDEX } from "../src/app/api/settings/field-service/archive/route";

const caseId = "10000000-0000-4000-8000-000000000001";
const objectId = "20000000-0000-4000-8000-000000000001";
const documentId = "30000000-0000-4000-8000-000000000001";

describe("field-service administrative archive API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.sql.mockResolvedValue([]);
    state.getDossier.mockResolvedValue({
      serviceCase: { id: caseId, reference: "FS-ARCHIVE-1" },
      attachments: [
        {
          objectId,
          category: "fault",
          processingStatus: "available",
        },
      ],
      calls: [],
      conversations: [],
      reports: [],
      customer: {
        contactId: "40000000-0000-4000-8000-000000000001",
        documents: [{ id: documentId, displayName: "warranty.pdf" }],
      },
    });
    state.getEvidenceMetadata.mockResolvedValue({
      id: objectId,
      status: "available",
      storageBackend: "local",
      storageKey: "tenant/case/fault.png",
      byteSize: 4,
      checksum: "checksum",
      contentType: "image/png",
    });
    state.getDocumentMetadata.mockResolvedValue({
      id: "50000000-0000-4000-8000-000000000001",
      displayName: "warranty.pdf",
      status: "available",
      storageBackend: "local",
      storageKey: "tenant/contact/warranty.pdf",
      byteSize: 4,
      checksum: "checksum",
      contentType: "application/pdf",
    });
    state.readObject.mockResolvedValue(Uint8Array.from([1, 2, 3, 4]));
    state.createZip.mockReturnValue(Buffer.from("synthetic-zip"));
    state.listArchive.mockResolvedValue({
      records: [],
      maximumRecords: 25_000,
      complete: true,
    });
  });

  it("builds a bounded ZIP from tenant-scoped dossier metadata and objects", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/settings/field-service/archive/${caseId}?format=zip`,
      ),
      { params: Promise.resolve({ id: caseId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.readObject).toHaveBeenCalledTimes(2);
    const entries = state.createZip.mock.calls[0]?.[0] as readonly {
      readonly path: string;
    }[];
    expect(entries.map((entry) => entry.path)).toEqual([
      "dossier.json",
      `Evidence/fault-${objectId}.png`,
      "Customer documents/50000000-0000-4000-8000-000000000001-warranty.pdf",
    ]);
    expect(state.createZip).toHaveBeenCalledWith(entries, {
      maximumEntries: 201,
      maximumUncompressedBytes: 251 * 1024 * 1024,
    });
  });

  it("keeps the default JSON dossier export independent of object storage", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/settings/field-service/archive/${caseId}`,
      ),
      { params: Promise.resolve({ id: caseId }) },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly dossier: { readonly serviceCase: { readonly id: string } };
    };
    expect(body.dossier.serviceCase.id).toBe(caseId);
    expect(state.readObject).not.toHaveBeenCalled();
    expect(state.createZip).not.toHaveBeenCalled();
  });

  it("refuses to emit a silently truncated tenant archive", async () => {
    state.listArchive.mockResolvedValue({
      records: [],
      maximumRecords: 25_000,
      complete: false,
    });

    const response = await GET_INDEX(
      new Request("http://localhost/api/settings/field-service/archive"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "The archive contains more than the explicit 25000-case synchronous export limit. No partial file was generated.",
    });
    expect(state.sql).not.toHaveBeenCalled();
  });
});
