import { describe, expect, it } from "vitest";
import type { VoiceSessionSummary } from "@or-on/api-client";
import { summarizeVoiceSample, transcriptEntries } from "../src/features/voice";

function session(
  overrides: Partial<VoiceSessionSummary> = {},
): VoiceSessionSummary {
  return {
    session_id: "fictional",
    contact_id: null,
    platform_campaign_id: null,
    provider: "simulator",
    direction: "outbound",
    status: "ended",
    answered: true,
    outcome: "simulator_completed",
    created_at: "2026-09-10T10:00:00Z",
    ended_at: "2026-09-10T10:10:00Z",
    usage: { call_seconds: 40 },
    cost: { total: 0 },
    ...overrides,
  };
}

describe("truthful Voice sample presentations", () => {
  it("uses recorded talk time, not session lifetime, for completed-call duration", () => {
    const summary = summarizeVoiceSample([
      session(),
      session({ usage: { call_seconds: 60 } }),
      session({
        status: "started",
        ended_at: null,
        usage: { call_seconds: 999 },
      }),
    ]);
    expect(summary.averageSeconds).toBe(50);
    expect(summary.active).toBe(1);
    expect(summary.states.reduce((sum, row) => sum + row.count, 0)).toBe(3);
  });
  it("does not fabricate a duration when no completed observations exist", () => {
    expect(summarizeVoiceSample([]).averageSeconds).toBeNull();
    expect(
      summarizeVoiceSample([session({ usage: { call_seconds: Number.NaN } })])
        .averageSeconds,
    ).toBeNull();
  });
  it("accepts actual transcript event text and rejects unrelated or malformed payloads", () => {
    const common = { occurred_at: "2026-09-10T10:00:00Z" };
    expect(
      transcriptEntries([
        {
          ...common,
          sequence: 1,
          event_type: "voice.call.transcript.updated.v1",
          payload: { text: "Fictional transcript" },
        },
        {
          ...common,
          sequence: 2,
          event_type: "voice.call.ended.v1",
          payload: { text: "not a transcript" },
        },
        {
          ...common,
          sequence: 3,
          event_type: "voice.call.transcript.updated.v1",
          payload: { text: 42 },
        },
      ]),
    ).toEqual([
      {
        sequence: 1,
        text: "Fictional transcript",
        speaker: null,
        occurredAt: common.occurred_at,
      },
    ]);
  });
});
