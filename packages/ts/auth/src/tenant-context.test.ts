import { describe, expect, it } from "vitest";

import { isUuidIdentifier } from "./tenant-context.js";

describe("tenant execution UUID validation", () => {
  it("accepts the reserved migration bootstrap tenant identifier", () => {
    expect(isUuidIdentifier("00000000-0000-0000-0000-000000000001")).toBe(true);
  });

  it("accepts generated user and tenant UUIDs", () => {
    expect(isUuidIdentifier("b5fe6bf9-4c53-49f9-b301-8ba60006762e")).toBe(true);
  });

  it.each([
    "",
    "not-a-uuid",
    "00000000-0000-0000-0000-00000000001",
    "00000000000000000000000000000001",
    "../../00000000-0000-0000-0000-000000000001",
  ])("rejects a non-canonical identifier: %s", (value) => {
    expect(isUuidIdentifier(value)).toBe(false);
  });
});
