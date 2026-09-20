import { describe, expect, it } from "vitest";
import { jsonObject } from "./request";

function request(body: string | Uint8Array, declared?: string) {
  return new Request("https://example.invalid/api/test", {
    method: "POST",
    body: typeof body === "string" ? body : new Uint8Array(body),
    ...(declared ? { headers: { "content-length": declared } } : {}),
  });
}

describe("bounded authenticated JSON request reader", () => {
  it("allows a route-selected larger bound without changing the default limit", async () => {
    const text = "א".repeat(20_000);
    const body = JSON.stringify({ text });
    await expect(jsonObject(request(body))).rejects.toThrow(
      "request body is too large",
    );
    await expect(
      jsonObject(request(body), { maximumBytes: 81_920 }),
    ).resolves.toEqual({ text });
    await expect(
      jsonObject(request(JSON.stringify({ text: "x".repeat(81_920) }), "1"), {
        maximumBytes: 81_920,
      }),
    ).rejects.toThrow("request body is too large");
  });
  it.each([0, -1, Infinity, NaN, 131_073, 1.5])(
    "refuses invalid server-selected byte bounds: %s",
    async (maximumBytes) => {
      await expect(jsonObject(request("{}"), { maximumBytes })).rejects.toThrow(
        "request body limit is invalid",
      );
    },
  );
  it.each([undefined, "1"])(
    "rejects actual bytes over limit despite content-length %s",
    async (length) => {
      await expect(
        jsonObject(
          request(JSON.stringify({ text: "x".repeat(16_384) }), length),
        ),
      ).rejects.toThrow("request body is too large");
    },
  );
  it("preserves the full allowed body including Hebrew text", async () => {
    const text = "א".repeat(8000);
    expect(await jsonObject(request(JSON.stringify({ text })))).toEqual({
      text,
    });
    const exact = JSON.stringify({ text: "x".repeat(16_373) });
    expect(Buffer.byteLength(exact)).toBe(16_384);
    expect(await jsonObject(request(exact))).toEqual({
      text: "x".repeat(16_373),
    });
  });
  it("cancels a chunked oversized stream before reading all remaining chunks", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10_000));
      },
      cancel() {
        canceled = true;
      },
    });
    const streaming = new Request("https://example.invalid/api/test", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    await expect(jsonObject(streaming)).rejects.toThrow(
      "request body is too large",
    );
    expect(canceled).toBe(true);
  });
  it.each(["null", "[]", '"text"', "1", "false"])(
    "rejects non-object JSON %s",
    async (raw) => {
      await expect(jsonObject(request(raw))).rejects.toThrow(
        "request body must be an object",
      );
    },
  );
  it.each(["{", '{"private":"secret"'])(
    "does not expose invalid JSON contents",
    async (raw) => {
      await expect(jsonObject(request(raw))).rejects.toThrow(
        "request body must contain valid JSON",
      );
    },
  );
  it("rejects malformed UTF-8 instead of replacing bytes", async () => {
    await expect(
      jsonObject(
        request(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])),
      ),
    ).rejects.toThrow("request body must contain valid JSON");
  });
  it.each(["NaN", "Infinity", "-1", "16385"])(
    "rejects invalid declared length %s",
    async (length) => {
      await expect(jsonObject(request("{}", length))).rejects.toThrow(
        "request body is too large",
      );
    },
  );
});
