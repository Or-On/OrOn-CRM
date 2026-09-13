import type { VoiceSessionDetail } from "@or-on/api-client";
import { Metric, SectionHeader, Surface } from "@or-on/ui";
import { useLocale } from "next-intl";

const stages = [
  "speech_end_to_accepted_ms",
  "model_first_token_ms",
  "validation_ms",
  "validated_to_synthesis_ms",
  "accepted_to_transport_signal_ms",
] as const;

const copy = {
  en: {
    title: "Conversation timing",
    hint: "Observed pipeline timing, not a guarantee of what the caller heard.",
    pending: "No timing observations are available for this call.",
    unknown: "Not observed",
    samples: "observations",
    playback:
      "Exact remote playback is not confirmed. Interrupted speech may be partial.",
    labels: [
      "Speech end → accepted text",
      "Model first token",
      "Evidence validation",
      "Validation → synthesized audio",
      "Accepted text → transport signal",
    ],
  },
  he: {
    title: "תזמון השיחה",
    hint: "מדידות מתהליך עיבוד השיחה, לא אישור למה שנשמע בפועל אצל הלקוח.",
    pending: "אין מדידות תזמון זמינות לשיחה הזו.",
    unknown: "לא נמדד",
    samples: "מדידות",
    playback:
      "השמעה מדויקת בצד המרוחק אינה מאושרת. דיבור שנקטע עשוי להישמע באופן חלקי.",
    labels: [
      "סוף דיבור ← טקסט שהתקבל",
      "הטוקן הראשון מהמודל",
      "בדיקת מקורות",
      "בדיקת מקורות ← יצירת קול",
      "טקסט שהתקבל ← אות מהתעבורה",
    ],
  },
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function VoiceQualitySummary({
  events,
}: {
  readonly events: VoiceSessionDetail["events"];
}) {
  const locale = useLocale();
  const text = copy[locale.startsWith("he") ? "he" : "en"];
  const event = events.find(
    (candidate) => candidate.event_type === "voice.quality.summary.v1",
  );
  const payload = object(event?.payload);
  const summary =
    payload?.schema_version === "1.0" ? object(payload.summary_ms) : undefined;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return (
    <Surface className="voice-cost-inspector">
      <SectionHeader title={text.title} description={text.hint} />
      {summary ? (
        <section aria-label={text.title} className="voice-call-facts">
          {stages.map((stage, index) => {
            const sample = object(summary[stage]);
            const samples = finite(sample?.samples) ? sample.samples : 0;
            const observed = samples > 0;
            const p50 =
              observed && finite(sample?.p50)
                ? `${number.format(sample.p50)} ms`
                : text.unknown;
            const p95 =
              observed && finite(sample?.p95)
                ? `${number.format(sample.p95)} ms`
                : text.unknown;
            return (
              <Metric
                key={stage}
                label={text.labels[index] ?? stage}
                value={p50}
                detail={`p50 · p95 ${p95} · ${String(samples)} ${text.samples}`}
              />
            );
          })}
        </section>
      ) : (
        <p>{text.pending}</p>
      )}
      <p>{text.playback}</p>
    </Surface>
  );
}
