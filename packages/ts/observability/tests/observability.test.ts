import { describe, expect, it } from "vitest";

import { redactSensitiveValues } from "../src/index.js";

describe("redactSensitiveValues", () => {
  it("redacts nested sensitive fields while retaining correlation fields", () => {
    const redacted = redactSensitiveValues({
      request_id: "request-1",
      tenant_id: "tenant-safe",
      nested: { accessToken: "never-print", value: "visible" },
    });

    expect(redacted).toEqual({
      request_id: "request-1",
      tenant_id: "tenant-safe",
      nested: { accessToken: "[REDACTED]", value: "visible" },
    });
  });
});
