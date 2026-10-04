import { describe, expect, it } from "vitest";
import { boundedMultipart } from "../src/features/uploads";

describe("bounded multipart request parsing", () => {
  it("preserves multipart fields and files", async () => {
    const form = new FormData();
    form.set("caption", "שלום");
    form.set("file", new File(["hello"], "note.txt"));
    const result = await boundedMultipart(
      new Request("https://example.test/upload", {
        method: "POST",
        body: form,
      }),
      4096,
    );
    expect(result.get("caption")).toBe("שלום");
    expect(await (result.get("file") as File).text()).toBe("hello");
  });
  it("cancels oversized chunked bodies despite a lying length header", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://example.test/upload", {
      method: "POST",
      body,
      duplex: "half",
      headers: {
        "content-length": "1",
        "content-type": "multipart/form-data; boundary=owned",
      },
    } as RequestInit);
    await expect(boundedMultipart(request, 1024)).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
  });
  it("rejects declared oversize without consuming a body", async () => {
    const request = new Request("https://example.test/upload", {
      method: "POST",
      body: "payload",
      headers: { "content-length": "9999" },
    });
    await expect(boundedMultipart(request, 1024)).rejects.toThrow("too large");
    expect(request.bodyUsed).toBe(false);
  });
  it("rejects invalid server-selected limits", async () => {
    await expect(
      boundedMultipart(new Request("https://example.test"), Number.NaN),
    ).rejects.toThrow("limit");
  });
});
