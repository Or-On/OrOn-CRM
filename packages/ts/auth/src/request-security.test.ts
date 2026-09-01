import { describe, expect, it } from "vitest";

import { assertTrustedUnsafeRequest } from "./index.js";

describe("unsafe request protection", () => {
  it("accepts a same-origin request", () => {
    const request = new Request(
      "https://platform.example.test/api/auth/logout",
      {
        method: "POST",
        headers: {
          origin: "https://platform.example.test",
          "sec-fetch-site": "same-origin",
        },
      },
    );
    expect(() => assertTrustedUnsafeRequest(request)).not.toThrow();
  });

  it("rejects a cross-origin request", () => {
    const request = new Request(
      "https://platform.example.test/api/auth/logout",
      {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
      },
    );
    expect(() => assertTrustedUnsafeRequest(request)).toThrow("not trusted");
  });
});
