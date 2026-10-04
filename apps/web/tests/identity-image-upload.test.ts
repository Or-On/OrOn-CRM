import { describe, expect, it } from "vitest";

import { readIdentityImage } from "../src/features/identity-upload-server";

function requestFor(bytes: Uint8Array, type = "application/octet-stream") {
  const form = new FormData();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  form.set("image", new File([buffer], "identity-image", { type }));
  return new Request("http://example.invalid/api/image", {
    body: form,
    method: "PATCH",
  });
}

describe("identity image validation", () => {
  it("detects a supported image from its signature instead of trusting the browser MIME", async () => {
    const bytes = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAG0lEQVR4nGNQSlv1nxLMMGrAqAGjBvwfJgYAAGE+MR8B/c+7AAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    await expect(readIdentityImage(requestFor(bytes))).resolves.toEqual({
      contentType: "image/png",
      data: bytes,
    });
  });

  it("rejects unsupported payloads and oversized images", async () => {
    await expect(
      readIdentityImage(requestFor(new Uint8Array([1, 2, 3]))),
    ).rejects.toThrow("valid PNG");
    await expect(
      readIdentityImage(requestFor(new Uint8Array(2 * 1024 * 1024 + 1))),
    ).rejects.toThrow("2 MB");
  });
});
