import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  voiceRecordingResponse: vi.fn(),
}));

vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
}));
vi.mock("../src/features/voice-server", () => ({
  voiceRecordingResponse: dependencies.voiceRecordingResponse,
}));

import { GET } from "../src/app/api/voice/sessions/[id]/recording/route";

describe("voice recording BFF", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streams an authorized recording without caching it", async () => {
    dependencies.voiceRecordingResponse.mockResolvedValue(
      new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "content-type": "audio/wav" },
      }),
    );

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "session-id" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([82, 73, 70, 70]),
    );
    expect(dependencies.voiceRecordingResponse).toHaveBeenCalledWith(
      "session-id",
      expect.any(Headers),
    );
  });

  it("forwards ranges and preserves partial bytes and representation headers", async () => {
    dependencies.voiceRecordingResponse.mockResolvedValue(
      new Response(new Uint8Array([82, 73]), {
        status: 206,
        headers: {
          "content-type": "audio/wav",
          "content-length": "2",
          "content-range": "bytes 0-1/15",
          "accept-ranges": "bytes",
          "set-cookie": "must-not-relay=1",
          "x-storage-key": "private",
        },
      }),
    );
    const response = await GET(
      new Request("http://localhost", { headers: { range: "bytes=0-1" } }),
      { params: Promise.resolve({ id: "session-id" }) },
    );
    const forwarded: unknown =
      dependencies.voiceRecordingResponse.mock.calls[0]?.[1];
    expect(forwarded).toBeInstanceOf(Headers);
    if (!(forwarded instanceof Headers))
      throw new Error("Missing forwarded headers");
    expect(forwarded.get("range")).toBe("bytes=0-1");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-1/15");
    expect(response.headers.get("content-length")).toBe("2");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-storage-key")).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([82, 73]),
    );
  });

  it("preserves an unsatisfiable range without inventing a successful recording", async () => {
    dependencies.voiceRecordingResponse.mockResolvedValue(
      new Response(null, {
        status: 416,
        headers: {
          "content-range": "bytes */15",
          "content-length": "0",
          "accept-ranges": "bytes",
        },
      }),
    );
    const response = await GET(
      new Request("http://localhost", { headers: { range: "bytes=15-" } }),
      { params: Promise.resolve({ id: "session-id" }) },
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */15");
    expect(await response.text()).toBe("");
  });

  it("does not turn a missing artifact into a successful audio response", async () => {
    dependencies.voiceRecordingResponse.mockResolvedValue(
      Response.json({ error: "not found" }, { status: 404 }),
    );

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Recording not found",
    });
  });
});
