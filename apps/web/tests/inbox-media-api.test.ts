import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  metadata: vi.fn(),
  read: vi.fn(),
  permissions: [] as string[],
}));

vi.mock("@or-on/crm", () => ({
  getMessageMediaObjectMetadata: state.metadata,
}));
vi.mock("../src/features/auth", () => ({
  withCurrentTenant: async (
    permission: string,
    operation: (sql: unknown) => unknown,
  ) => {
    state.permissions.push(permission);
    const result = await operation({});
    return result;
  },
}));
vi.mock("../src/features/crm-route", () => ({
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    ),
}));
vi.mock("../src/features/private-objects", () => ({
  readPrivateObject: state.read,
}));

import { GET } from "../src/app/api/messaging/messages/[id]/media/route";

const messageId = "30000000-0000-4000-8000-000000000001";
const context = {
  params: Promise.resolve({ id: messageId }),
} as Parameters<typeof GET>[1];

function metadata(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    messageId,
    contentType: "image/png",
    byteSize: 4,
    checksum: "fixture-checksum",
    storageBackend: "local",
    storageKey: "tenant/message/fixture.png",
    status: "available",
    fileName: "תמונה של לקוח.png",
    ...overrides,
  };
}

describe("Inbox media API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions.length = 0;
    state.metadata.mockResolvedValue(metadata());
    state.read.mockResolvedValue(Uint8Array.from([1, 2, 3, 4]));
  });

  it("serves authorized private images with safe Unicode disposition headers", async () => {
    const response = await GET(
      new Request(`http://localhost/api/messaging/messages/${messageId}/media`),
      context,
    );

    expect(response.status).toBe(200);
    expect(state.permissions).toEqual(["crm:read"]);
    expect(state.metadata).toHaveBeenCalledWith({}, messageId);
    expect(state.read).toHaveBeenCalledWith(
      "tenant/message/fixture.png",
      metadata(),
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toMatch(
      /^inline; filename="_+ __ ____\.png"; filename\*=UTF-8''%D7/u,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("forces documents to download", async () => {
    state.metadata.mockResolvedValue(
      metadata({ contentType: "application/pdf", fileName: "invoice.pdf" }),
    );
    const response = await GET(
      new Request(`http://localhost/api/messaging/messages/${messageId}/media`),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="invoice\.pdf"/u,
    );
  });

  it("does not read bytes when tenant authorization finds no available object", async () => {
    state.metadata.mockResolvedValue(undefined);
    const response = await GET(
      new Request(`http://localhost/api/messaging/messages/${messageId}/media`),
      context,
    );
    expect(response.status).toBe(404);
    expect(state.read).not.toHaveBeenCalled();

    state.metadata.mockResolvedValue(metadata({ storageBackend: "gcs" }));
    const unavailableAdapter = await GET(
      new Request(`http://localhost/api/messaging/messages/${messageId}/media`),
      context,
    );
    expect(unavailableAdapter.status).toBe(503);
    expect(state.read).not.toHaveBeenCalled();
  });
});
