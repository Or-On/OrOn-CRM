import { describe, expect, it } from "vitest";

import {
  boundedTranscript,
  type PostCallTranscriptTurn,
} from "./post-call-provider.js";

function turns(count: number, size = 120): PostCallTranscriptTurn[] {
  return Array.from({ length: count }, (_unused, index) => ({
    index: index + 1,
    role: index % 2 === 0 ? "user" : "assistant",
    text: "x".repeat(size),
    interrupted: false,
  }));
}

describe("bounded transcript selection", () => {
  it("passes a short call through untouched", () => {
    const selected = boundedTranscript(turns(6));

    expect(selected).toHaveLength(6);
    expect(selected.every((entry) => "index" in entry)).toBe(true);
  });

  it("keeps the issue at the start and the resolution at the end", () => {
    const selected = boundedTranscript(turns(400), 4_000);
    const kept = selected.filter(
      (entry): entry is PostCallTranscriptTurn => "index" in entry,
    );

    // Either half alone loses exactly what the classification depends on: the
    // problem is stated at the top and confirmed or not at the bottom.
    expect(kept[0]?.index).toBe(1);
    expect(kept.at(-1)?.index).toBe(400);
    expect(selected.some((entry) => "omitted" in entry)).toBe(true);
  });

  it("preserves turn numbers across the gap so citations stay valid", () => {
    const selected = boundedTranscript(turns(400), 4_000);
    const kept = selected.filter(
      (entry): entry is PostCallTranscriptTurn => "index" in entry,
    );

    expect(kept.map((turn) => turn.index)).toEqual(
      [...kept].map((turn) => turn.index).toSorted((a, b) => a - b),
    );
    expect(new Set(kept.map((turn) => turn.index)).size).toBe(kept.length);
  });

  it("truncates one enormous turn rather than dropping the call", () => {
    const selected = boundedTranscript(turns(2, 20_000), 8_000);
    const kept = selected.filter(
      (entry): entry is PostCallTranscriptTurn => "index" in entry,
    );

    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]?.text.length).toBeLessThanOrEqual(1_200);
  });
});
