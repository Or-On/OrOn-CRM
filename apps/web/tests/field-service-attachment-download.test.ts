import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  metadata: vi.fn(),
  read: vi.fn(),
  permissions: [] as string[],
}));

vi.mock("@or-on/crm", () => ({
  getFieldServiceObjectMetadata: state.metadata,
}));
vi.mock("../src/features/auth", () => ({
  withCurrentTenant: async (
    permission: string,
    operation: (sql: unknown) => Promise<unknown>,
  ) => {
    state.permissions.push(permission);
    return operation({});
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
vi.mock("../src/features/field-service", () => ({
  uuid: (value: unknown) => String(value),
}));

import { GET } from "../src/app/api/field-service/attachments/[id]/route";

const context = {
  params: Promise.resolve({ id: "30000000-0000-4000-8000-000000000001" }),
};

describe("field-service attachment response safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions.length = 0;
    state.read.mockResolvedValue(Uint8Array.from([1, 2, 3, 4]));
  });

  it.each([
    ["application/pdf", "attachment"],
    ["text/plain", "attachment"],
    ["image/png", "inline"],
  ])("serves %s using %s disposition", async (contentType, disposition) => {
    state.metadata.mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000001",
      status: "available",
      storageBackend: "local",
      storageKey: "tenant/case/evidence",
      byteSize: 4,
      contentType,
      checksum: "checksum",
    });

    const response = await GET(
      new Request("http://localhost/evidence"),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      new RegExp(`^${disposition};`, "u"),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(state.permissions).toEqual(["field-service:read"]);
  });
});
