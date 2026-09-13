import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  conversationChannelKey,
  conversationDayKey,
  previousConversationDay,
} from "./conversation-presentation";

describe("Inbox presentation contracts", () => {
  it("groups calendar days in the configured timezone, including UTC+14 and DST boundaries", () => {
    const instant = new Date("2026-09-11T01:30:00Z");
    expect(conversationDayKey(instant, "UTC")).toBe("2026-09-11");
    expect(conversationDayKey(instant, "America/Los_Angeles")).toBe(
      "2026-09-10",
    );
    expect(
      conversationDayKey(
        new Date("2026-09-10T13:00:00Z"),
        "Pacific/Kiritimati",
      ),
    ).toBe("2026-09-11");
    expect(previousConversationDay("2026-09-11")).toBe("2026-09-10");
    expect(previousConversationDay("2026-03-09")).toBe("2026-03-08");
    expect(previousConversationDay("2026-01-01")).toBe("2025-12-31");
  });

  it("maps all stored channel kinds and never invents WhatsApp for an unknown channel", () => {
    expect(
      ["whatsapp", "email", "sms", "webchat", "future"].map(
        conversationChannelKey,
      ),
    ).toEqual([
      "inbox.whatsapp",
      "shell.email",
      "inbox.sms",
      "inbox.webchat",
      "common.unknown",
    ]);
  });

  it("keeps context out of the grid throughout the compact-channel breakpoint", () => {
    const css = readFileSync(
      resolve(import.meta.dirname, "../../app/studio-replica.css"),
      "utf8",
    );
    expect(css).toMatch(
      /@media \(max-width: 69\.999rem\)\s*\{\s*\.inbox-workspace,/u,
    );
    expect(css).toMatch(
      /@media \(max-width: 69\.999rem\)\s*\{\s*\.shell--inbox \.inbox-workspace,/u,
    );
    expect(css).not.toMatch(
      /@media \(max-width: 63\.999rem\)\s*\{\s*\.inbox-workspace,/u,
    );
  });
});
