import { afterEach, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/v1/contacts/route";

afterEach(() => vi.unstubAllEnvs());
it("rejects unauthenticated malformed JSON before consuming the request body", async () => {
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://fictional:fictional@127.0.0.1:1/fictional",
  );
  vi.stubEnv("AUTH_TOKEN_PEPPER", "fictional-only-pepper-01234567890123456789");
  const request = new Request("http://localhost/api/v1/contacts", {
    method: "POST",
    body: "{",
  });
  const response = await POST(request);
  expect(response.status).toBe(401);
  expect(request.bodyUsed).toBe(false);
});
it("rejects an oversized unauthenticated body without parsing", async () => {
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://fictional:fictional@127.0.0.1:1/fictional",
  );
  vi.stubEnv("AUTH_TOKEN_PEPPER", "fictional-only-pepper-01234567890123456789");
  const request = new Request("http://localhost/api/v1/contacts", {
    method: "POST",
    body: JSON.stringify({ name: "x".repeat(2 * 1024 * 1024) }),
  });
  const response = await POST(request);
  expect(response.status).toBe(401);
  expect(request.bodyUsed).toBe(false);
});
