import { describe, expect, it } from "vitest";
import { parseMessageCursor, templateSummary } from "./messaging.js";

describe("message history projections", () => {
  it("preserves PostgreSQL microseconds in a validated cursor", () => {
    const date = "2026-09-03T10:01:02.123456Z";
    const id = "20000000-0000-4000-8000-000000000001";
    expect(parseMessageCursor(date, id)).toEqual({ createdAt: date, id });
    expect(parseMessageCursor(null, null)).toBeUndefined();
    expect(() => parseMessageCursor(date, null)).toThrow("Invalid");
    expect(() => parseMessageCursor("2026-13-44T10:01:02.123Z", id)).toThrow(
      "Invalid",
    );
    expect(() => parseMessageCursor(date, "not-a-uuid")).toThrow("Invalid");
  });
  it("exposes only template display fields, never arbitrary payload metadata", () => {
    expect(
      templateSummary({
        templateName: "hello_world",
        language: "en_US",
        parameters: ["Fictional"],
        token: "never-forward",
      }),
    ).toEqual({
      name: "hello_world",
      language: "en_US",
      parameters: ["Fictional"],
    });
    expect(
      templateSummary({
        templateName: "hello",
        language: "he",
        parameters: [1],
      }),
    ).toBeNull();
    expect(templateSummary(null)).toBeNull();
  });
});
