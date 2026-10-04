import { describe, it, expect, vi } from "vitest";
import { MetaWhatsAppProvider } from "../src/providers.js";

function mediaProvider(fetcher: typeof fetch, timeoutMs = 1000) {
  return new MetaWhatsAppProvider({
    enabled: true,
    accessToken: "fictional-test-token",
    phoneNumberId: "123",
    graphApiVersion: "v26.0",
    fetch: fetcher,
    timeoutMs,
  });
}
const metadata = () =>
  Response.json({
    url: "https://lookaside.fbsbx.com/fictional-media",
    mime_type: "audio/ogg",
  });
describe("bounded private media transport", () => {
  it("rejects oversized metadata before decoding JSON", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(32769)));
    await expect(
      mediaProvider(fetcher).downloadMedia({ mediaId: "456" }),
    ).rejects.toMatchObject({ code: "media_too_large" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("cancels an oversized chunked body without a content length", async () => {
    const canceled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
      },
      cancel: canceled,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(
        new Response(stream, { headers: { "content-type": "audio/ogg" } }),
      );
    await expect(
      mediaProvider(fetcher).downloadMedia({ mediaId: "456" }),
    ).rejects.toMatchObject({ code: "media_too_large", retryable: false });
    expect(canceled).toHaveBeenCalledOnce();
  });
  it("bounds stalled body reads separately from HTTP headers", async () => {
    const canceled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel: canceled });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(
        new Response(stream, { headers: { "content-type": "audio/ogg" } }),
      );
    await expect(
      mediaProvider(fetcher, 20).downloadMedia({ mediaId: "456" }),
    ).rejects.toMatchObject({ code: "media_body_timeout", retryable: true });
    expect(canceled).toHaveBeenCalledOnce();
  });
  it("requires redirect rejection and retains guarded valid transport", async () => {
    const beforeAttempt = vi.fn<() => Promise<void>>().mockResolvedValue();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/ogg" },
        }),
      );
    await expect(
      mediaProvider(fetcher).downloadMedia({ mediaId: "456", beforeAttempt }),
    ).resolves.toMatchObject({ contentType: "audio/ogg" });
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls)
      expect(call[1]?.redirect).toBe("error");
    // Private storage, rather than transport, validates actual audio structure.
  });
});
