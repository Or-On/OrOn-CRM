import { describe, expect, it } from "vitest";
import { composeSessionMemory, summaryInputs } from "./messaging-memory.js";

describe("shadow session memory context", () => {
  const turns = Array.from({ length: 25 }, (_, index) => ({
    id: String(index),
    text: `customer-${String(index)}`,
    source: "customer" as const,
  }));
  it("never places shadow or disabled memory in the prompt", () => {
    for (const input of [
      { enabled: false, shadow: false },
      { enabled: true, shadow: true },
    ])
      expect(
        composeSessionMemory({ ...input, turns, facts: [], summaries: [] }),
      ).toBe("");
  });
  it("retains only the latest twenty turns and three summaries", () => {
    const value = composeSessionMemory({
      enabled: true,
      shadow: false,
      turns,
      facts: [],
      summaries: Array.from({ length: 5 }, (_, id) => ({
        id: String(id),
        text: `summary-${String(id)}`,
        coveredUntilMessageId: String(id),
      })),
    });
    expect(value).not.toContain("customer-4]");
    expect(value).not.toContain("customer-4\n");
    expect(value).toContain("customer-24");
    expect(value).not.toContain("summary-1");
    expect(value).toContain("summary-4");
  });
  it("bounds multilingual content conservatively including astral code points", () => {
    const value = composeSessionMemory({
      enabled: true,
      shadow: false,
      turns: [{ id: "1", source: "customer", text: "שלום😀".repeat(2000) }],
      summaries: [],
      facts: [],
      tokenBudget: 500,
    });
    expect(Array.from(value).length).toBeLessThanOrEqual(500);
    expect(value).not.toContain("\uFFFD");
  });
  it("reserves operator corrections before old free text under a tight budget", () => {
    const input = {
      enabled: true,
      shadow: false,
      turns: [
        { id: "old", text: "OldCity".repeat(20), source: "customer" as const },
      ],
      summaries: [],
      facts: [
        {
          id: "fix",
          key: "city",
          value: "CorrectCity",
          confidence: "stated" as const,
          sourceMessageId: "",
          sourceCorrectionId: "audit",
          provenance: "operator_correction" as const,
        },
      ],
    };
    const context = composeSessionMemory({ ...input, tokenBudget: 80 });
    expect(context).toContain("[operator correction audit] city: CorrectCity");
    expect(context).not.toContain("OldCity");
    expect(composeSessionMemory({ ...input, tokenBudget: 10 })).toBe("");
  });
  it("rejects an unbounded context budget", () => {
    expect(() =>
      composeSessionMemory({
        enabled: true,
        shadow: false,
        turns,
        summaries: [],
        facts: [],
        tokenBudget: 4001,
      }),
    ).toThrow(TypeError);
  });
  it("summary source excludes model-generated notes even if an untyped caller supplies them", () => {
    const unsafe = [
      ...turns.slice(0, 1),
      { id: "fake", source: "ai_note", text: "invented" },
    ];
    expect(
      summaryInputs(unsafe as Parameters<typeof summaryInputs>[0]),
    ).toEqual(turns.slice(0, 1));
  });
});
