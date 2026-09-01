import { describe, expect, it } from "vitest";

import { dedupeContactsByPhone, normalizeE164 } from "./index.js";

describe("canonical contact phone identity", () => {
  it("normalizes explicit international formatting without guessing country", () => {
    expect(normalizeE164("+1 (415) 555-0123")).toBe("+14155550123");
    expect(normalizeE164("054-123-4567")).toBeUndefined();
    expect(normalizeE164("+012345678")).toBeUndefined();
  });

  it("deduplicates imports on canonical E.164 values", () => {
    const result = dedupeContactsByPhone([
      { name: "First", phone: "+14155550123" },
      { name: "Duplicate", phone: "+1 415 555 0123" },
      { name: "Invalid", phone: "4155550123" },
    ]);
    expect(result.unique).toEqual([{ name: "First", phone: "+14155550123" }]);
    expect(result.duplicates).toBe(2);
  });
});
