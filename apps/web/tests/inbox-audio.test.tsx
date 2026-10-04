import { describe, expect, it } from "vitest";
import type { Message } from "@or-on/crm";
import { AudioMessageContent } from "../src/features/inbox";
import { renderMarkup } from "./localized";

const message: Message = {
  id: "30000000-0000-4000-8000-000000000001",
  conversationId: "fixture",
  direction: "inbound",
  senderType: "contact",
  contentType: "audio",
  contentText: "<script>customer transcript</script>",
  status: "received",
  providerMessageId: null,
  createdAt: "2026-10-04T00:00:00Z",
  reactions: [],
  deliveryEvents: [],
  media: {
    kind: "audio",
    status: "available",
    mimeType: "audio/ogg",
    fileName: null,
    caption: null,
    transcriptionStatus: "completed",
  },
};
function requiredMedia(value: Message["media"]): NonNullable<Message["media"]> {
  if (!value) throw new Error("fixture audio media missing");
  return value;
}
const fixtureMedia = requiredMedia(message.media);
describe("private customer voice-message presentation", () => {
  it.each(["en", "he"] as const)(
    "renders keyboard-native labeled controls and escaped transcript in %s",
    (locale) => {
      const html = renderMarkup(
        <AudioMessageContent message={message} />,
        locale,
      );
      expect(html).toContain("<audio");
      expect(html).toContain("controls=");
      expect(html).toContain('preload="none"');
      expect(html).toContain('aria-label="');
      expect(html).toContain(`/api/messaging/messages/${message.id}/media`);
      expect(html).not.toContain("autoplay");
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain('dir="auto"');
    },
  );
  it("does not show claimed transcript text while pending or failed", () => {
    for (const status of ["pending", "failed", "disabled"] as const) {
      const html = renderMarkup(
        <AudioMessageContent
          message={{
            ...message,
            media: { ...fixtureMedia, transcriptionStatus: status },
          }}
        />,
      );
      expect(html).not.toContain("customer transcript");
      expect(html).toContain('role="status"');
    }
  });
  it("never fetches unsupported MIME or unavailable media", () => {
    for (const media of [
      { ...fixtureMedia, mimeType: "text/html" },
      { ...fixtureMedia, status: "failed" as const },
    ]) {
      const html = renderMarkup(
        <AudioMessageContent message={{ ...message, media }} />,
      );
      expect(html).not.toContain("<audio");
      expect(html).not.toContain("src=");
    }
  });
});
