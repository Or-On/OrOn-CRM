import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  withApiKeyTenant: vi.fn(),
  createContact: vi.fn(),
  listContacts: vi.fn(),
}));

class InvalidApiKeyError extends Error {}

vi.mock("@or-on/config", () => ({
  loadConfig: () => ({
    databaseUrl: "postgresql://fixture.invalid/test",
    secrets: { authTokenPepper: "fixture-pepper" },
  }),
}));

vi.mock("@or-on/crm", () => ({
  InvalidApiKeyError,
  withApiKeyTenant: dependencies.withApiKeyTenant,
  createContact: dependencies.createContact,
  listContacts: dependencies.listContacts,
}));

const { GET, POST } = await import("../src/app/api/v1/contacts/route");
const validToken = `oron_${"a".repeat(40)}`;

function request(body?: string, token = validToken) {
  return new Request("http://localhost/api/v1/contacts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: body ?? null,
  });
}

describe("public contacts API responses", () => {
  beforeEach(() => {
    dependencies.withApiKeyTenant.mockImplementation(
      async (
        _url: string,
        _pepper: string,
        _token: string,
        _scope: string,
        operation: (sql: object) => Promise<unknown>,
      ) => await operation({}),
    );
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("rejects a missing bearer credential", async () => {
    const response = await GET(new Request("http://localhost/api/v1/contacts"));
    expect(response.status).toBe(401);
    expect(dependencies.withApiKeyTenant).not.toHaveBeenCalled();
  });

  it("reports an invalid API key as unauthorized", async () => {
    dependencies.withApiKeyTenant.mockRejectedValueOnce(
      new InvalidApiKeyError("invalid API key"),
    );
    const response = await GET(
      new Request("http://localhost/api/v1/contacts", {
        headers: { authorization: `Bearer ${validToken}` },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects malformed JSON and blank contact names as client errors", async () => {
    expect((await POST(request("{"))).status).toBe(400);
    expect((await POST(request(JSON.stringify({ name: "  " })))).status).toBe(
      400,
    );
    expect(dependencies.withApiKeyTenant).toHaveBeenCalledTimes(2);
  });

  it("does not misreport an operation error as a credential failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    dependencies.withApiKeyTenant.mockRejectedValueOnce(
      new TypeError("contact operation failed"),
    );
    const response = await POST(request(JSON.stringify({ name: "Ada" })));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Service unavailable" });
  });

  it("trims a valid name before creating the contact", async () => {
    dependencies.withApiKeyTenant.mockImplementationOnce(
      async (
        _databaseUrl: string,
        _pepper: string,
        _token: string,
        _scope: string,
        operation: (sql: object) => Promise<unknown>,
      ) => await operation({}),
    );
    dependencies.createContact.mockResolvedValueOnce({ id: "contact-1" });
    const response = await POST(request(JSON.stringify({ name: "  Ada  " })));
    expect(response.status).toBe(201);
    expect(dependencies.createContact).toHaveBeenCalledWith({}, null, {
      name: "Ada",
    });
  });
});
