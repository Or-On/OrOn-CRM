"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Textarea } from "@or-on/ui";
import type { AgentProviderEvaluationResult } from "@or-on/api-client";
import { crmMutation } from "../crm";
import { isAgentProviderEvaluationResult } from "./provider-result";

export function AgentProviderEvaluation({
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
  const [result, setResult] = useState<AgentProviderEvaluationResult>();
  const active = useRef(true);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);
  return (
    <section
      className="feature-form"
      aria-label={he ? "הערכת מודל בתשלום" : "Paid model evaluation"}
    >
      <h4>{he ? "הערכת מודל בתשלום" : "Paid model evaluation"}</h4>
      <p>
        {he
          ? "בדיקת טקסט אמיתית מול מודל השיחה המוגדר, עם הידע המאושר והגרסה שפורסמה. הבקשה שולחת טקסט וידע לספק ועלולה לחייב בתשלום. אין שמע, זיהוי דיבור, כלים או פעולות עסקיות."
          : "A real typed request to the configured conversational model using the published version and approved knowledge. Text and knowledge are sent to the provider and may incur charges. No audio, STT, tools, or business actions run."}
      </p>
      <p>
        {he
          ? "השתמשו בתרחיש לא רגיש. מוצגת רק תשובה שאומתה מול הידע העדכני, לא פלט גולמי או חשיבה פנימית. התוצאות אינן נשמרות בשרת. עלות אינה ידועה ללא נתוני חיוב מהספק."
          : "Use a non-sensitive scenario. Only the answer validated against current knowledge is shown, never raw model output or internal reasoning. Results are not stored on the server. Cost is unknown without provider billing data."}
      </p>
      {!published ? (
        <p>{he ? "נדרשת גרסה שפורסמה." : "A published version is required."}</p>
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
          setResult(undefined);
          void crmMutation<{ evaluation: unknown }>(
            `${endpoint}/provider-evaluate`,
            {
              versionId,
              text: form.get("providerScenario"),
              confirmed: form.get("providerConfirmed") === "on",
            },
            { signal: controller.signal },
          )
            .then(({ evaluation }) => {
              if (!active.current || controller.signal.aborted) return;
              if (!isAgentProviderEvaluationResult(evaluation, versionId))
                throw new Error("invalid evaluation");
              setResult(evaluation);
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
          id={`provider-scenario-${versionId}`}
          name="providerScenario"
          maxLength={1000}
          required
          disabled={!published || pending}
          label={
            he
              ? "תרחיש מוקלד (עד 1,000 תווים)"
              : "Typed scenario (up to 1,000 characters)"
          }
        />
        <Checkbox
          id={`provider-confirm-${versionId}`}
          name="providerConfirmed"
          required
          disabled={!published || pending}
        >
          {he
            ? "אני מאשר/ת שליחת טקסט וידע מאושר לספק וחיוב אפשרי עבור הבקשה"
            : "I confirm sending this text and approved knowledge to the provider and possible charges"}
        </Checkbox>
        <Button type="submit" busy={pending} disabled={!published}>
          {he ? "הפעלת הערכת מודל בתשלום" : "Run paid model evaluation"}
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
          {he ? "ביטול הערכה" : "Cancel evaluation"}
        </Button>
      ) : null}
      <p>
        {he
          ? "ביטול משליך פלט מאוחר; חיוב או עיבוד שכבר בוצעו אינם מתבטלים."
          : "Cancellation discards late output; provider processing or charges already incurred cannot be undone."}
      </p>
      {failed ? (
        <p role="alert">
          {he
            ? "הערכת המודל אינה זמינה. לא הוחלפה בתוצאה מדומה."
            : "Model evaluation unavailable. No simulated result was substituted."}
        </p>
      ) : null}
      {result ? (
        <div aria-live="polite">
          <p>
            {result.provider} · {result.model}
          </p>
          <dl>
            <dt>{he ? "טקסט שנקלט" : "Accepted typed text"}</dt>
            <dd dir="auto">{result.accepted_text}</dd>
            <dt>{he ? "תשובה מאומתת" : "Validated answer"}</dt>
            <dd dir="auto">{result.response}</dd>
            <dt>{he ? "תוצאת אימות" : "Validation decision"}</dt>
            <dd>{result.decision}</dd>
            <dt>
              {he
                ? "זמן מודל / אימות (אלפיות שנייה)"
                : "Model / validation time (milliseconds)"}
            </dt>
            <dd>
              {result.model_ms.toFixed(1)} / {result.validation_ms.toFixed(1)}
            </dd>
          </dl>
          {result.sources.length ? (
            <ul>
              {result.sources.map((source) => (
                <li key={source.document_id}>
                  <code>
                    {source.fact_key} · {source.document_id} · v{source.version}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {he
                ? "לא נבחרה עובדה מאושרת; התשובה היא שיחה מוגבלת או הבהרה."
                : "No approved fact was selected; the answer is a bounded conversational response or clarification."}
            </p>
          )}
          <p>
            {he
              ? "עלות: לא ידועה. זיהוי דיבור, סינתזה ופעולות: לא הופעלו."
              : "Cost: unknown. STT, synthesis, and actions: not run."}
          </p>
        </div>
      ) : null}
    </section>
  );
}
