import { describe, expect, it } from "vitest";
import { messageMedia } from "./messaging.js";
describe("audio and video presentation boundaries", () => {
  it("requires a validated available audio object, not a provider MIME claim", () => {
    expect(
      messageMedia("audio", {
        mimeType: "audio/ogg",
        retrievalStatus: "available",
      }),
    ).toMatchObject({ status: "unavailable" });
    expect(
      messageMedia(
        "audio",
        {
          providerMediaId: "private",
          sha256: "private",
          transcriptionStatus: "failed",
        },
        "audio/ogg",
      ),
    ).toEqual({
      kind: "audio",
      status: "available",
      mimeType: "audio/ogg",
      fileName: null,
      caption: null,
      transcriptionStatus: "failed",
    });
    expect(messageMedia("audio", {}, "text/html")?.status).toBe("unavailable");
  });
  it("requires canonical validated MP4 for video availability", () => {
    expect(
      messageMedia("video", { caption: "Customer caption" }, "video/mp4"),
    ).toMatchObject({
      kind: "video",
      status: "available",
      mimeType: "video/mp4",
    });
    for (const mime of [null, "video/quicktime", "video/3gpp", "text/html"]) {
      expect(
        messageMedia(
          "video",
          { mimeType: "video/mp4", retrievalStatus: "available" },
          mime,
        ),
      ).toMatchObject({ kind: "video", status: "unavailable" });
    }
    expect(
      messageMedia("video", { retrievalStatus: "processing" }),
    ).toMatchObject({ kind: "video", status: "processing" });
    expect(messageMedia("video", { retrievalStatus: "failed" })).toMatchObject({
      kind: "video",
      status: "failed",
    });
  });
});
