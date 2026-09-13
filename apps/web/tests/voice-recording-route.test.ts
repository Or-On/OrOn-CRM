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
    );
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
