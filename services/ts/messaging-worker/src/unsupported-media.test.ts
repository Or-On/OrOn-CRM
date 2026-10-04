import { describe, expect, it } from "vitest";
import {
  unsupportedInboundMedia,
  unsupportedMediaReply,
} from "./unsupported-media.js";

describe("declared unsupported media", () => {
  it("rejects unsupported video containers and stickers", () => {
    expect(
      unsupportedInboundMedia({
        contentType: "video",
        media: { id: "fictional", mimeType: "video/3gpp" },
      }),
    ).toBe(true);
    expect(
      unsupportedInboundMedia({
        contentType: "video",
        media: { id: "fictional", mimeType: "video/mp4" },
      }),
    ).toBe(false);
    expect(
      unsupportedInboundMedia({
        contentType: "image",
        providerMessageType: "sticker",
      }),
    ).toBe(true);
  });
  it("preserves supported declared types and leaves unknown MIME to verified retrieval", () => {
    expect(
      unsupportedInboundMedia({
        contentType: "image",
        media: { id: "fictional", mimeType: "image/png" },
      }),
    ).toBe(false);
    expect(
      unsupportedInboundMedia({
        contentType: "audio",
        media: { id: "fictional", mimeType: "audio/ogg; codecs=opus" },
      }),
    ).toBe(false);
    expect(
      unsupportedInboundMedia({
        contentType: "document",
        media: { id: "fictional", mimeType: "application/pdf" },
      }),
    ).toBe(false);
    expect(
      unsupportedInboundMedia({
        contentType: "image",
        media: { id: "fictional" },
      }),
    ).toBe(false);
    expect(
      unsupportedInboundMedia({
        contentType: "document",
        media: { id: "fictional", mimeType: "application/zip" },
      }),
    ).toBe(true);
  });
  it("uses fixed honest localized text", () => {
    expect(unsupportedMediaReply("he-IL")).toContain("הודעת טקסט");
    expect(unsupportedMediaReply("ar")).toContain("كنص");
    expect(unsupportedMediaReply("en")).toContain(
      "cannot read this media type",
    );
  });
});
