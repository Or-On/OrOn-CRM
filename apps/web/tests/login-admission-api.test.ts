import { describe, expect, it, vi } from "vitest";
import { AuthenticationBusyError } from "@or-on/auth";
const state = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("../src/features/auth", () => ({
  requestId: () => "owned-busy",
  jsonObject: (request: Request) => request.json(),
  setSessionCookies: state.cookies,
  withAuthService: () => Promise.reject(new AuthenticationBusyError()),
}));
import { POST } from "../src/app/api/auth/login/route";
describe("login admission HTTP contract", () => {
  it("reports overload truthfully without cookies or retry queue", async () => {
    const response = await POST(
      new Request("https://example.test/api/auth/login", {
        method: "POST",
        headers: {
          origin: "https://example.test",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "owned@example.invalid",
          password: "owned",
        }),
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.cookies).not.toHaveBeenCalled();
  });
});
