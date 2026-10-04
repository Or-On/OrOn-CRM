import { describe, expect, it } from "vitest";

import { createLogger, redactSensitiveValues } from "../src/index.js";

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

  it("redacts deep objects and arrays in actual emitted logs", () => {
    const output: string[] = [];
    const logger = createLogger(
      { service: "test", environment: "test" },
      { write: (line: string) => output.push(line) },
    );
    logger.info(
      {
        request_id: "safe-correlation",
        token: "top-level-synthetic-secret",
        response: { body: { accessToken: "deep-synthetic-secret" } },
        items: [{ credentials: { password: "array-synthetic-secret" } }],
      },
      "safe message",
    );
    const line = output.join("");
    expect(line).not.toContain("synthetic-secret");
    expect(JSON.parse(line)).toMatchObject({
      request_id: "safe-correlation",
      token: "[REDACTED]",
      response: { body: { accessToken: "[REDACTED]" } },
      items: [{ credentials: "[REDACTED]" }],
    });
  });

  it("keeps errors, dates and circular diagnostic objects loggable", () => {
    const output: string[] = [];
    const logger = createLogger(
      { service: "test", environment: "test" },
      { write: (line: string) => output.push(line) },
    );
    const diagnostic: Record<string, unknown> = { secret: "synthetic-private" };
    diagnostic.self = diagnostic;
    logger.error({
      err: new Error("safe failure"),
      at: new Date("2026-10-03T00:00:00Z"),
      diagnostic,
    });
    const line = output.join("");
    expect(line).not.toContain("synthetic-private");
    expect(JSON.parse(line)).toMatchObject({
      err: { type: "Error", message: "safe failure" },
      at: "2026-10-03T00:00:00.000Z",
      diagnostic: { secret: "[REDACTED]" },
    });
  });
});
