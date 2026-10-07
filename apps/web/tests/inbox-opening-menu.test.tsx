import { describe, expect, it } from "vitest";
import type { Message } from "@or-on/crm";
import { OpeningMenuContent } from "../src/features/inbox";
import { renderMarkup } from "./localized";
const base: Message = {
  id: "fixture",
  conversationId: "fixture",
  direction: "outbound",
  senderType: "system",
  contentType: "template",
  contentText: null,
  status: "sending",
  providerMessageId: null,
  createdAt: "2026-10-04T00:00:00Z",
  reactions: [],
  deliveryEvents: [],
};
describe("opening menu history", () => {
  it("shows the actual Hebrew buttons even in an English operator interface", () => {
    const html = renderMarkup(
      <OpeningMenuContent
        message={{
          ...base,
          openingMenu: {
            outcome: "sent",
            buttons: ["מידע על שירותים", "עזרה או תקלה"],
          },
        }}
      />,
      "en",
    );
    expect(html).toContain("מידע על שירותים");
    expect(html).toContain("עזרה או תקלה");
    expect(html).not.toContain("<li>Services</li>");
  });
  it.each(["en", "he"] as const)(
    "unknown outcome is honest and noninteractive in %s",
    (locale) => {
      const html = renderMarkup(
        <OpeningMenuContent
          message={{ ...base, openingMenu: { outcome: "unknown" } }}
        />,
        locale,
      );
      expect(html).toContain('role="status"');
      expect(html).toContain(
        locale === "en"
          ? "operator reconciliation required before retry"
          : "נדרש בירור של מפעיל",
      );
      expect(html).not.toContain("<button");
      expect(html).not.toContain("spinner");
      expect(html).toContain("<li>");
    },
  );
  it.each(["sending", "sent", "failed"] as const)(
    "renders finite %s notice",
    (outcome) => {
      const html = renderMarkup(
        <OpeningMenuContent message={{ ...base, openingMenu: { outcome } }} />,
      );
      expect(html).toContain('role="status"');
      expect(html).not.toContain("<button");
    },
  );
  it("does not invent a menu for ordinary template", () => {
    expect(renderMarkup(<OpeningMenuContent message={base} />)).toBe("");
  });
});
