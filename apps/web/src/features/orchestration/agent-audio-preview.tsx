"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Textarea } from "@or-on/ui";
import type { AudioPreviewResult } from "@or-on/api-client";
import { crmMutation } from "../crm";
import { isAudioPreviewResult } from "./provider-result";

export function AgentAudioPreview({
  endpoint,
  versionId,
  published,
  locale,
}: {
  readonly endpoint: string;
  readonly versionId: string;
  readonly published: boolean;
  readonly locale: string;
}) {
  const he = locale === "he";
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [audio, setAudio] = useState<{
    url: string;
    preview: AudioPreviewResult;
  }>();
  const active = useRef(true);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!audio) return;
    const timeout = setTimeout(() => setAudio(undefined), 60_000);
    return () => {
      clearTimeout(timeout);
      URL.revokeObjectURL(audio.url);
    };
  }, [audio]);
  return (
    <section
      className="feature-form"
      aria-label={he ? "תצוגה מקדימה קולית" : "Audio preview"}
    >
      <h4>{he ? "תצוגה מקדימה קולית" : "Audio preview"}</h4>
      <p>
        {he
          ? "בקשה מפורשת זו שולחת את הטקסט לספק הדיבור המוגדר (Soniox או Gemini) ועלולה לחייב בתשלום. מופק דיבור בלבד — ללא זיהוי דיבור, מודל שיחה או שיחת טלפון."
          : "This explicit request sends text to the configured speech provider (Soniox or Gemini) and may incur charges. It synthesizes speech only: no STT, conversational LLM, or telephone call."}
      </p>
      <p>
        {he
          ? "רק הגרסה שפורסמה נבדקת, ללא שינויים שלא נשמרו. השתמשו בטקסט בדיקה לא רגיש. הנגן נמחק לאחר 60 שניות; אין שמירה בשרת. מדיניות השמירה של הספק חלה."
          : "Only the published version is previewed, not unsaved edits. Use non-sensitive test text. Playback is cleared after 60 seconds; no server storage is created. Provider retention policies apply."}
      </p>
      {!published ? (
        <p>
          {he
            ? "יש לפרסם גרסה לפני הפקת דיבור."
            : "Publish a version before synthesizing its speech."}
        </p>
      ) : null}
      <form
        className="feature-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          request.current?.abort();
          const controller = new AbortController();
          request.current = controller;
          setPending(true);
          setFailed(false);
          setAudio(undefined);
          void crmMutation<{ preview: unknown }>(
            `${endpoint}/audio-preview`,
            {
              versionId,
              text: form.get("previewText"),
              confirmed: form.get("previewConfirmed") === "on",
            },
            { signal: controller.signal },
          )
            .then(({ preview }) => {
              if (!active.current || controller.signal.aborted) return;
              if (!isAudioPreviewResult(preview, versionId))
                throw new Error("invalid preview");
              const bytes = Uint8Array.from(
                atob(preview.audio_base64),
                (character) => character.charCodeAt(0),
              );
              setAudio({
                url: URL.createObjectURL(
                  new Blob([bytes], { type: "audio/wav" }),
                ),
                preview,
              });
            })
            .catch(() => {
              if (active.current && !controller.signal.aborted) setFailed(true);
            })
            .finally(() => {
              if (active.current && request.current === controller)
                setPending(false);
            });
        }}
      >
        <Textarea
          id={`audio-preview-text-${versionId}`}
          name="previewText"
          maxLength={300}
          required
          disabled={!published || pending}
          label={
            he
              ? "טקסט להקראה (עד 300 תווים)"
              : "Text to synthesize (up to 300 characters)"
          }
        />
        <Checkbox
          id={`audio-preview-confirm-${versionId}`}
          name="previewConfirmed"
          required
          disabled={!published || pending}
        >
          {he
            ? "אני מאשר/ת שליחת טקסט לספק והוצאה אפשרית עבור הבקשה הזו"
            : "I confirm sending this text to the provider and possible charges for this request"}
        </Checkbox>
        <Button type="submit" busy={pending} disabled={!published}>
          {he ? "הפקת דיבור בתשלום" : "Generate paid speech preview"}
        </Button>
      </form>
      {pending ? (
        <Button
          variant="quiet"
          onClick={() => {
            request.current?.abort();
            setPending(false);
          }}
        >
          {he ? "ביטול התצוגה" : "Cancel preview"}
        </Button>
      ) : null}
      <p>
        {he
          ? "ביטול מונע הצגת פלט מאוחר; לא ניתן לבטל חיוב או עיבוד שכבר בוצעו אצל הספק."
          : "Cancellation discards late output; it cannot undo provider processing or charges already incurred."}
      </p>
      {failed ? (
        <p role="alert">
          {he
            ? "לא ניתן להפיק דיבור. הספק עשוי להיות כבוי, לא זמין או עמוס. לא הופק שמע חלופי."
            : "Preview unavailable: the provider may be disabled, unavailable, or busy. No replacement audio was fabricated."}
        </p>
      ) : null}
      {audio ? (
        <div aria-live="polite">
          <p>
            {audio.preview.provider} · {audio.preview.model} ·{" "}
            {audio.preview.voice}
          </p>
          <dl>
            <dt>{he ? "טקסט מקורי" : "Authored text"}</dt>
            <dd dir="auto">{audio.preview.canonical_text}</dd>
            <dt>
              {he
                ? "קלט מנורמל לדיבור — לא אישור למה שנשמע"
                : "Speech-normalized input — not verified heard speech"}
            </dt>
            <dd dir="auto">{audio.preview.speech_normalized_text}</dd>
          </dl>
          <audio
            controls
            style={{ width: "100%" }}
            src={audio.url}
            aria-label={he ? "נגן תצוגה מקדימה" : "Audio preview playback"}
          />
          <p>
            {he
              ? "זהו פלט ספק, לא אישור לאיכות ההגייה. האזנה ואימות אנושי עדיין נדרשים."
              : "This is provider output, not pronunciation-quality approval. Human listening and validation are still required."}
          </p>
        </div>
      ) : null}
    </section>
  );
}
