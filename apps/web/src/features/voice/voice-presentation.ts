import type {
  VoiceSessionDetail,
  VoiceSessionSummary,
} from "@or-on/api-client";

/** The API returns the latest 50 sessions, so every result describes that sample. */
export function summarizeVoiceSample(sessions: readonly VoiceSessionSummary[]) {
  const finished = sessions.filter((session) => session.status === "ended");
  const durations = finished
    .map((session) => session.usage.call_seconds)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
  return {
    active: sessions.filter((session) => session.status === "started").length,
    answered: sessions.filter((session) => session.answered === true).length,
    completed: finished.length,
    failed: sessions.filter((session) => session.status === "failed").length,
    averageSeconds:
      durations.length === 0
        ? null
        : Math.round(
            durations.reduce((sum, value) => sum + value, 0) / durations.length,
          ),
    states: Array.from(new Set(sessions.map((session) => session.status))).map(
      (status) => ({
        status,
        count: sessions.filter((session) => session.status === status).length,
      }),
    ),
  };
}

/** Only display transcript text that exists in an authenticated session event. */
export function transcriptEntries(events: VoiceSessionDetail["events"]) {
  return events.flatMap((event) => {
    if (
      !event.event_type.includes("transcript") ||
      typeof event.payload.text !== "string" ||
      !event.payload.text.trim()
    )
      return [];
    return [
      {
        sequence: event.sequence,
        text: event.payload.text,
        speaker:
          typeof event.payload.speaker === "string"
            ? event.payload.speaker
            : null,
        occurredAt: event.occurred_at,
      },
    ];
  });
}
