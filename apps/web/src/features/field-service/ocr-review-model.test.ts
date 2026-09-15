import { describe, expect, it } from "vitest";

import { ocrQueueParameters, ocrQueueViewCount } from "./ocr-review-model";

describe("OCR review queue presentation model", () => {
  const counts = {
    all: 5,
    attention: 2,
    inFlight: 2,
    completed: 1,
  } as const;

  it("selects the exact server count for each pressed filter", () => {
    expect(ocrQueueViewCount(counts, "attention")).toBe(2);
    expect(ocrQueueViewCount(counts, "in_flight")).toBe(2);
    expect(ocrQueueViewCount(counts, "completed")).toBe(1);
    expect(ocrQueueViewCount(counts, "all")).toBe(5);
  });

  it("builds a trimmed server filter with a complete keyset cursor", () => {
    expect(
      ocrQueueParameters("  MODEL-HE  ", "completed", {
        status: "confirmed",
        createdAt: "2026-09-15T08:00:00.000Z",
        id: "10000000-0000-4000-8000-000000000001",
      }).toString(),
    ).toBe(
      "limit=24&view=completed&q=MODEL-HE&cursorStatus=confirmed&cursorAt=2026-09-15T08%3A00%3A00.000Z&cursorId=10000000-0000-4000-8000-000000000001",
    );
  });
});
