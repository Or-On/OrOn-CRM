import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  composeWhatsAppInstructions,
  instructionTextSnapshot,
} from "./whatsapp-instructions.js";

describe("effective WhatsApp instruction composition", () => {
  it("retains ordered runtime blocks, Unicode counts and exact UTF8 text hash", () => {
    const input = {
      systemPrompt: "שלום 👋",
      locale: "he",
      capabilities: [] as const,
      actionNames: ["reply"],
      businessProfileAvailable: true,
      channelContactable: true,
    };
    const result = composeWhatsAppInstructions(input);
    expect(result).toEqual(composeWhatsAppInstructions(input));
    expect(result.blocks.map((b) => b.id)).toContain(
      "context.tenant_business_profile",
    );
    expect(result.blocks.map((b) => b.id)).toContain(
      "context.channel_contactability",
    );
    expect(result.blocks.at(-1)?.id).toBe("channel.envelope");
    expect(result.hash).toBe(
      createHash("sha256").update(result.text, "utf8").digest("hex"),
    );
    expect(result.characterCount).toBe(Array.from(result.text).length);
    expect(instructionTextSnapshot("א👋").characterCount).toBe(2);
    expect(
      composeWhatsAppInstructions({ ...input, replyOnly: true }).hash,
    ).not.toBe(result.hash);
    expect(
      composeWhatsAppInstructions({ ...input, channelContactable: false }).hash,
    ).not.toBe(result.hash);
  });
  it("keeps tenant prose outside security authority and never includes customer data", () => {
    const result = composeWhatsAppInstructions({
      systemPrompt: "Own role",
      locale: "he",
      capabilities: [],
      actionNames: ["reply"],
    });
    expect(result.blocks.find((b) => b.authority === "agent")?.text).toContain(
      "Own role",
    );
    expect(
      result.blocks.find((b) => b.id === "context.tenant_business_profile"),
    ).toBeUndefined();
  });
});
