import { describe, expect, it } from "vitest";
import { readIdentityImage } from "../src/features/identity-upload-server";
async function upload(extraBytes = 0): Promise<Request> {
  const form = new FormData();
  form.set(
    "image",
    new File(
      [
        Uint8Array.from(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAG0lEQVR4nGNQSlv1nxLMMGrAqAGjBvwfJgYAAGE+MR8B/c+7AAAAAElFTkSuQmCC",
            "base64",
          ),
        ),
      ],
      "avatar.png",
      { type: "image/png" },
    ),
  );
  if (extraBytes) form.set("ignored", "x".repeat(extraBytes));
  const encoded = new Request("https://example.test/upload", {
    method: "POST",
    body: form,
  });
  return new Request(encoded.url, {
    method: "POST",
    headers: encoded.headers,
    body: await encoded.arrayBuffer(),
  });
}
describe("identity multipart aggregate admission", () => {
  it("rejects oversized ignored fields without a content-length header", async () => {
    await expect(
      readIdentityImage(await upload(3 * 1024 * 1024)),
    ).rejects.toThrow("too large");
  });
});

it("preserves valid image upload", async () => {
  expect((await readIdentityImage(await upload())).contentType).toBe(
    "image/png",
  );
});
it("rejects declared oversize before reading the stream", async () => {
  const request = await upload();
  request.headers.set("content-length", String(3 * 1024 * 1024));
  await expect(readIdentityImage(request)).rejects.toThrow("too large");
  expect(request.bodyUsed).toBe(false);
});
it("rejects unsupported content despite a valid declared MIME type", async () => {
  const form = new FormData();
  form.set(
    "image",
    new File(["<svg onload=alert(1)>"], "evil.png", { type: "image/png" }),
  );
  await expect(
    readIdentityImage(
      new Request("https://example.test/upload", {
        method: "POST",
        body: form,
      }),
    ),
  ).rejects.toThrow("valid PNG");
});
