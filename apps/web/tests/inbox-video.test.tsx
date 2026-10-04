import { describe, expect, it } from "vitest";
import type { Message } from "@or-on/crm";
import { VideoMessageContent } from "../src/features/inbox";
import { renderMarkup } from "./localized";
const media = {
  kind: "video" as const,
  status: "available" as const,
  mimeType: "video/mp4",
  fileName: "<script>movie</script>",
  caption: "<script>caption</script>",
};
const message: Message = {
  id: "30000000-0000-4000-8000-000000000001",
  conversationId: "fixture",
  direction: "inbound",
  senderType: "contact",
  contentType: "video",
  contentText: null,
  status: "received",
  providerMessageId: null,
  createdAt: "2026-10-04T00:00:00Z",
  reactions: [],
  deliveryEvents: [],
  media,
};
describe("private customer video", () => {
  it.each(["en", "he"] as const)(
    "renders local native controls and escaped customer text in %s",
    (locale) => {
      const html = renderMarkup(
        <VideoMessageContent message={message} />,
        locale,
      );
      expect(html).toContain("<video");
      expect(html).toContain("controls=");
      expect(html).toContain('preload="none"');
      expect(html).toContain("playsInline=");
      expect(html).toContain('aria-label="');
      expect(html).toContain(`/api/messaging/messages/${message.id}/media`);
      expect(html).not.toContain("autoplay");
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain('dir="auto"');
      expect(html).toContain("download=");
    },
  );
  it.each(["pending", "failed", "unavailable", "processing"] as const)(
    "does not load unavailable %s media",
    (status) => {
      const html = renderMarkup(
        <VideoMessageContent
          message={{ ...message, media: { ...media, status } }}
        />,
      );
      expect(html).not.toContain("<video");
      expect(html).not.toContain("src=");
      expect(html).toContain('role="status"');
    },
  );
  it("rejects unsupported MIME even when metadata claims availability", () => {
    const html = renderMarkup(
      <VideoMessageContent
        message={{ ...message, media: { ...media, mimeType: "text/html" } }}
      />,
    );
    expect(html).not.toContain("<video");
    expect(html).not.toContain("src=");
    expect(html).not.toContain("download=");
  });
});
