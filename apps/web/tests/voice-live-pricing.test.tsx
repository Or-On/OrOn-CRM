// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveCallSummary } from "../src/features/voice";
import { localized } from "./localized";

const initial = {
  answered: true,
  contact_id: null,
  cost: {
    llm: 0.001,
    stt: 0.002,
    total: 0.003,
    unpriced: ["carrier"],
  },
  created_at: "2026-09-10T10:00:00Z",
  direction: "outbound" as const,
  ended_at: null,
  events: [],
  outcome: null,
  platform_campaign_id: null,
  provider: "livekit",
  recording_available: false,
  recording_object_id: null,
  session_id: "40000000-0000-4000-8000-000000000001",
  status: "started" as const,
  transcript_available: false,
  transcript_object_id: null,
  usage: { call_seconds: 10 },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("live voice pricing", () => {
  it("refreshes the authenticated call estimate while a call is active", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((url) => {
        if (typeof url === "string" && url.endsWith("/control"))
          return Promise.resolve(
            Response.json(
              { error: "not part of this pricing fixture" },
              { status: 404 },
            ),
          );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...initial,
              cost: {
                llm: 0.004,
                stt: 0.003,
                total: 0.0198,
                tts: 0.0128,
                unpriced: ["carrier"],
              },
              usage: { call_seconds: 14 },
            }),
            { headers: { "Content-Type": "application/json" }, status: 200 },
          ),
        );
      });

    render(localized(<LiveCallSummary initial={initial} />));
    expect(screen.getByText("$0.0030")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/session-detail",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.getByText("$0.0198")).toBeTruthy();
    expect(screen.getByText("14 seconds")).toBeTruthy();
  });
});
