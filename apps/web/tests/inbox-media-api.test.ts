import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  metadata: vi.fn(),
  read: vi.fn(),
  permissions: [] as string[],
  authorizationError: undefined as Error | undefined,
  events: [] as string[],
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
    state.events.push("auth");
    if (state.authorizationError) throw state.authorizationError;
    const result = await operation({});
    return result;
  },
}));
vi.mock("../src/features/crm-route", () => ({
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failed" },
      {
        status:
          error instanceof Error && error.name === "ForbiddenError" ? 403 : 400,
      },
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
    state.events.length = 0;
    state.authorizationError = undefined;
    state.metadata.mockImplementation(() => {
      state.events.push("metadata");
      return Promise.resolve(metadata());
    });
    state.read.mockImplementation(() => {
      state.events.push("private-read");
      return Promise.resolve(Uint8Array.from([1, 2, 3, 4]));
    });
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
  it.each([
    ["audio/ogg", "ogg"],
    ["audio/wav", "wav"],
    ["video/mp4", "mp4"],
  ])(
    "serves authorized %s inline with private headers",
    async (contentType, extension) => {
      state.metadata.mockResolvedValue(
        metadata({ contentType, fileName: null }),
      );
      const response = await GET(
        new Request(
          `http://localhost/api/messaging/messages/${messageId}/media`,
        ),
        context,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("content-disposition")).toMatch(/^inline;/u);
      expect(response.headers.get("content-disposition")).toContain(
        `.${extension}`,
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("cross-origin-resource-policy")).toBe(
        "same-origin",
      );
      expect(state.permissions).toEqual(["crm:read"]);
    },
  );

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
  it.each([
    ["bytes=1-2", 206, "bytes 1-2/4", [2, 3]],
    ["bytes=2-", 206, "bytes 2-3/4", [3, 4]],
    ["bytes=-2", 206, "bytes 2-3/4", [3, 4]],
    ["bytes=4-", 416, "bytes */4", []],
    ["bytes=0-1,2-3", 416, "bytes */4", []],
  ] as const)(
    "serves bounded private %s only after authorization and integrity",
    async (range, status, contentRange, expected) => {
      const response = await GET(
        new Request(
          `http://localhost/api/messaging/messages/${messageId}/media`,
          { headers: { range } },
        ),
        context,
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(response.headers.get("content-length")).toBe(
        String(expected.length),
      );
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(
        expected,
      );
      expect(state.events).toEqual(["auth", "metadata", "private-read"]);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
    },
  );
  it("ignores If-Range without an issued validator", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/messaging/messages/${messageId}/media`,
        { headers: { range: "bytes=0-0", "if-range": "untrusted-etag" } },
      ),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-length")).toBe("4");
  });
  it("never leaks file extent or reads metadata/bytes before fresh authorization", async () => {
    state.authorizationError = Object.assign(new Error("Forbidden"), {
      name: "ForbiddenError",
    });
    const response = await GET(
      new Request(
        `http://localhost/api/messaging/messages/${messageId}/media`,
        { headers: { range: "bytes=99999-" } },
      ),
      context,
    );
    expect(response.status).toBe(403);
    expect(state.metadata).not.toHaveBeenCalled();
    expect(state.read).not.toHaveBeenCalled();
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("does not disclose extent of foreign or removed media", async () => {
    state.metadata.mockResolvedValue(undefined);
    const response = await GET(
      new Request(
        `http://localhost/api/messaging/messages/${messageId}/media`,
        { headers: { range: "bytes=99999-" } },
      ),
      context,
    );
    expect(response.status).toBe(404);
    expect(state.read).not.toHaveBeenCalled();
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBeNull();
  });
  it("integrity failure precedes even an unsatisfiable range", async () => {
    state.read.mockRejectedValue(
      new TypeError("Private object integrity check failed"),
    );
    const response = await GET(
      new Request(
        `http://localhost/api/messaging/messages/${messageId}/media`,
        { headers: { range: "bytes=99999-" } },
      ),
      context,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBeNull();
  });
  it.each([NaN, -1, 0, 16 * 1024 * 1024 + 1])(
    "refuses invalid video metadata length %s before file IO",
    async (byteSize) => {
      state.metadata.mockResolvedValue(
        metadata({ contentType: "video/mp4", byteSize }),
      );
      const response = await GET(
        new Request(
          `http://localhost/api/messaging/messages/${messageId}/media`,
        ),
        context,
      );
      expect(response.status).toBe(404);
      expect(state.read).not.toHaveBeenCalled();
    },
  );
});
