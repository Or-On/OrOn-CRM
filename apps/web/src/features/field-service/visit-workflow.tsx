"use client";

import type { ServiceVisit, VisitPreparation } from "@or-on/crm";
import { Button, Dialog, InlineFeedback } from "@or-on/ui";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { csrfToken } from "../crm";

type VisitEvent = "en_route" | "work_started" | "work_completed";

const COPY = {
  en: {
    scheduled: "Scheduled",
    enRoute: "On the way",
    arrival: "Actual arrival",
    workStarted: "Work started",
    workCompleted: "Work completed",
    departure: "Departure",
    notYet: "Not recorded",
    actions: {
      en_route: "I'm on the way",
      work_started: "Start work",
      work_completed: "Complete work",
    },
    arrivalHint: "Arrival is recorded with the arrival signature.",
    preparationTitle: "Preparing for this call",
    summary: "Call summary",
    checklist: "Equipment and checklist",
    required: "required",
    instructions: "Instructions",
    acknowledge: "I have prepared",
    later: "Later",
    acknowledged: "Preparation confirmed",
    reference: "Reference",
    fault: "Fault",
    product: "Product",
    location: "Location",
    window: "Scheduled window",
    failed: "The action could not be completed.",
  },
  he: {
    scheduled: "מועד מתוכנן",
    enRoute: "יצא לדרך",
    arrival: "הגעה בפועל",
    workStarted: "תחילת עבודה",
    workCompleted: "סיום עבודה",
    departure: "יציאה מהאתר",
    notYet: "טרם נרשם",
    actions: {
      en_route: "יצאתי לדרך",
      work_started: "התחלתי עבודה",
      work_completed: "סיימתי עבודה",
    },
    arrivalHint: "ההגעה נרשמת עם חתימת ההגעה.",
    preparationTitle: "הצטיידות לקריאה",
    summary: "סיכום הקריאה",
    checklist: "ציוד ורשימת בדיקה",
    required: "חובה",
    instructions: "הנחיות",
    acknowledge: "הצטיידתי",
    later: "אחר כך",
    acknowledged: "ההצטיידות אושרה",
    reference: "מספר קריאה",
    fault: "תקלה",
    product: "מוצר",
    location: "מיקום",
    window: "חלון זמן מתוכנן",
    failed: "לא ניתן היה להשלים את הפעולה.",
  },
} as const;

/** Full date and time in the tenant's configured time zone. */
function formatInstant(
  value: string | null | undefined,
  locale: string,
  timezone: string,
): string | null {
  if (value === null || value === undefined) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}

function errorText(error: unknown, he: boolean, fallback: string): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "messages" in error &&
    error.messages !== null &&
    typeof error.messages === "object"
  ) {
    const messages = error.messages as { he?: unknown; en?: unknown };
    const selected = he ? messages.he : messages.en;
    if (typeof selected === "string") return selected;
  }
  return error instanceof Error ? error.message : fallback;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken(),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) throw payload;
  return payload;
}

/**
 * The visit's explicit timeline. Arrival is only ever the signed arrival
 * event; nothing here infers it from opening the page or a schedule.
 */
export function VisitWorkflow({
  visit,
  canWork,
  timezone,
  scheduledStart,
  scheduledEnd,
}: {
  readonly visit: ServiceVisit;
  readonly canWork: boolean;
  readonly timezone: string;
  readonly scheduledStart?: string | null;
  readonly scheduledEnd?: string | null;
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const t = COPY[he ? "he" : "en"];
  const router = useRouter();
  const [busy, setBusy] = useState<VisitEvent>();
  const [message, setMessage] = useState<string>();
  const rows: readonly (readonly [string, string | null | undefined])[] = [
    [
      t.scheduled,
      scheduledStart === undefined || scheduledStart === null
        ? null
        : `${formatInstant(scheduledStart, locale, timezone) ?? ""}${
            scheduledEnd
              ? ` – ${formatInstant(scheduledEnd, locale, timezone) ?? ""}`
              : ""
          }`,
    ],
    [t.enRoute, formatInstant(visit.enRouteAt, locale, timezone)],
    [t.arrival, formatInstant(visit.arrivalAt, locale, timezone)],
    [t.workStarted, formatInstant(visit.workStartedAt, locale, timezone)],
    [t.workCompleted, formatInstant(visit.workCompletedAt, locale, timezone)],
    [t.departure, formatInstant(visit.departureAt, locale, timezone)],
  ];
  const closed = visit.status === "cancelled" || visit.status === "reported";
  const next: VisitEvent | undefined = closed
    ? undefined
    : !visit.enRouteAt && !visit.arrivalAt
      ? "en_route"
      : visit.arrivalAt && !visit.workStartedAt
        ? "work_started"
        : visit.workStartedAt && !visit.workCompletedAt
          ? "work_completed"
          : undefined;

  async function record(event: VisitEvent) {
    setBusy(event);
    setMessage(undefined);
    try {
      await postJson(`/api/field-service/visits/${visit.id}/events`, { event });
      router.refresh();
    } catch (error) {
      setMessage(errorText(error, he, t.failed));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="service-visit-timeline">
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value ?? t.notYet}</dd>
          </div>
        ))}
      </dl>
      {canWork && next !== undefined ? (
        <Button
          busy={busy === next}
          disabled={busy !== undefined}
          onClick={() => {
            void record(next);
          }}
          type="button"
        >
          {t.actions[next]}
        </Button>
      ) : null}
      {canWork && visit.enRouteAt && !visit.arrivalAt && !closed ? (
        <small>{t.arrivalHint}</small>
      ) : null}
      {message === undefined ? null : (
        <InlineFeedback description={message} tone="critical" />
      )}
    </div>
  );
}

/**
 * "הצטיידות לקריאה": shown to the assigned technician before departure until
 * the current requirements are acknowledged, and again only if they change.
 */
export function PreparationPrompt({
  visit,
  canWork,
  timezone,
}: {
  readonly visit: ServiceVisit | undefined;
  readonly canWork: boolean;
  readonly timezone: string;
}) {
  const locale = useLocale();
  const he = locale.startsWith("he");
  const t = COPY[he ? "he" : "en"];
  const router = useRouter();
  const [preparation, setPreparation] = useState<VisitPreparation>();
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const eligible =
    visit !== undefined &&
    canWork &&
    !visit.enRouteAt &&
    !visit.arrivalAt &&
    visit.status === "assigned";

  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    void fetch(`/api/field-service/visits/${visit.id}/preparation`, {
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { preparation: VisitPreparation })
          : undefined,
      )
      .then((payload) => {
        if (payload === undefined) return;
        setPreparation(payload.preparation);
        setChecked(new Set(payload.preparation.checkedItems ?? []));
        if (
          payload.preparation.enabled &&
          payload.preparation.acknowledged !== true
        )
          setOpen(true);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [eligible, visit]);

  if (visit === undefined || !preparation?.enabled) return null;
  const summary = preparation.summary ?? {};
  const checklist = preparation.checklist ?? [];
  const missingRequired = checklist.some(
    (item) => item.required && !checked.has(item.key),
  );

  async function acknowledge() {
    if (visit === undefined || preparation?.requirementsHash === undefined)
      return;
    setBusy(true);
    setMessage(undefined);
    try {
      await postJson(`/api/field-service/visits/${visit.id}/preparation`, {
        requirementsHash: preparation.requirementsHash,
        checkedItems: [...checked],
      });
      setOpen(false);
      router.refresh();
    } catch (error) {
      setMessage(errorText(error, he, t.failed));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {preparation.acknowledged === true ? (
        <InlineFeedback description={t.acknowledged} tone="positive" />
      ) : (
        <Button
          onClick={() => {
            setOpen(true);
          }}
          type="button"
          variant="secondary"
        >
          {t.preparationTitle}
        </Button>
      )}
      <Dialog
        closeLabel={t.later}
        onClose={() => {
          setOpen(false);
        }}
        open={open}
        title={t.preparationTitle}
      >
        <div className="service-preparation">
          <h3>{t.summary}</h3>
          <dl>
            <div>
              <dt>{t.reference}</dt>
              <dd dir="ltr">{summary.reference ?? ""}</dd>
            </div>
            <div>
              <dt>{t.fault}</dt>
              <dd dir="auto">
                {summary.faultDescription ?? summary.title ?? ""}
              </dd>
            </div>
            {summary.productType || summary.productModel ? (
              <div>
                <dt>{t.product}</dt>
                <dd dir="auto">
                  {[summary.productType, summary.productModel]
                    .filter(Boolean)
                    .join(" · ")}
                </dd>
              </div>
            ) : null}
            {summary.locationName || summary.locationAddress ? (
              <div>
                <dt>{t.location}</dt>
                <dd dir="auto">
                  {[
                    summary.chainName,
                    summary.locationName,
                    summary.locationAddress,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </dd>
              </div>
            ) : null}
            {summary.scheduledStart ? (
              <div>
                <dt>{t.window}</dt>
                <dd>
                  {formatInstant(
                    summary.scheduledStart,
                    locale,
                    summary.scheduleTimezone ?? timezone,
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
          {checklist.length === 0 ? null : (
            <fieldset>
              <legend>{t.checklist}</legend>
              {checklist.map((item) => (
                <label key={item.key}>
                  <input
                    checked={checked.has(item.key)}
                    onChange={(event) => {
                      const next = new Set(checked);
                      if (event.target.checked) next.add(item.key);
                      else next.delete(item.key);
                      setChecked(next);
                    }}
                    type="checkbox"
                  />
                  <span dir="auto">{item.label}</span>
                  {item.required ? <small> ({t.required})</small> : null}
                </label>
              ))}
            </fieldset>
          )}
          {preparation.instructions ? (
            <>
              <h3>{t.instructions}</h3>
              <p dir="auto">{preparation.instructions}</p>
            </>
          ) : null}
          {message === undefined ? null : (
            <InlineFeedback description={message} tone="critical" />
          )}
          <div className="service-preparation-actions">
            <Button
              busy={busy}
              disabled={busy || missingRequired}
              onClick={() => {
                void acknowledge();
              }}
              type="button"
            >
              {t.acknowledge}
            </Button>
            <Button
              onClick={() => {
                setOpen(false);
              }}
              type="button"
              variant="secondary"
            >
              {t.later}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
