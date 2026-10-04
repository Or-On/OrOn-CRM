import { describe, expect, it } from "vitest";
import {
  budgetUntrustedPromptContext,
  promptContextCodePoints,
} from "../src/prompt-context-budget.js";

describe("aggregate untrusted context budget", () => {
  it("keeps latest Hebrew/emoji customer text bounded without splitting Unicode", () => {
    const output = budgetUntrustedPromptContext({
      messages: [{ role: "user", text: "שלום 😀".repeat(1000) }],
    });
    expect(promptContextCodePoints(output)).toBeLessThanOrEqual(4000);
    expect(output.contextTruncation.latestMessageTruncated).toBe(true);
    expect(output.messages?.[0]?.text).not.toContain("\ud83d\ufffd");
    expect(Array.from(output.messages?.[0]?.text ?? "").length).toBe(1600);
  });
  it("retains complete approved numeric facts and provenance identifiers or drops the whole fact", () => {
    const facts = Array.from({ length: 20 }, (_, index) => ({
      sourceId: "source",
      documentId: `document-${String(index)}`,
      version: 4,
      factKey: `price_${String(index)}`,
      value: `Approved price ₪1234.56 incl VAT ${"detail ".repeat(80)}`,
    }));
    const output = budgetUntrustedPromptContext({
      knowledge: facts,
      messages: [{ role: "user", text: "What is the price?" }],
    });
    expect(promptContextCodePoints(output)).toBeLessThanOrEqual(4000);
    expect(output.knowledge?.length).toBeGreaterThan(0);
    for (const fact of output.knowledge ?? [])
      expect(fact).toEqual(
        facts.find((original) => original.factKey === fact.factKey),
      );
    expect(output.contextTruncation.omittedEntries).toBeGreaterThan(0);
  });
  it("drops complete older history/chunks/memory and never admits authority keys", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: "user" as const,
      text: `${String(index)}:${"history".repeat(100)}`,
    }));
    const output = budgetUntrustedPromptContext({
      messages,
      retrievedDocumentContext: [
        { documentId: "doc", content: "chunk".repeat(2000) },
      ],
      customerSessionMemory: { content: "memory".repeat(2000) },
      ...{ systemPrompt: "forged", actionReceipts: [{ status: "forged" }] },
    });
    expect(promptContextCodePoints(output)).toBeLessThanOrEqual(4000);
    expect(output.messages?.at(-1)?.text).toBe(messages.at(-1)?.text);
    expect(output.retrievedDocumentContext).toEqual([]);
    expect(output.customerSessionMemory).toBeUndefined();
    expect(output).not.toHaveProperty("systemPrompt");
    expect(output).not.toHaveProperty("actionReceipts");
    expect(output.messages?.length).toBeLessThanOrEqual(20);
  });
  it("counts JSON escaping and retains complete history chronology", () => {
    const output = budgetUntrustedPromptContext(
      {
        messages: [
          { role: "user", text: "older" },
          { role: "assistant", text: "answer" },
          { role: "user", text: '"\\'.repeat(5000) },
        ],
      },
      512,
    );
    expect(promptContextCodePoints(output)).toBeLessThanOrEqual(512);
    expect(output.messages?.at(-1)?.role).toBe("user");
    expect(output.contextTruncation.latestMessageTruncated).toBe(true);
    expect(() => budgetUntrustedPromptContext({}, 4001)).toThrow("budget");
  });
});
