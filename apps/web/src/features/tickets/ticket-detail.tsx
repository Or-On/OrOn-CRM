"use client";

import type { TicketCallAttempt, TicketDetail } from "@or-on/crm";
import { useLocale } from "next-intl";
import Link from "next/link";

import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import styles from "./tickets-workspace.module.css";

const COPY = {
  en: {
    back: "All tickets",
    contact: "Contact",
    assurance: "Identification",
    problem: "Current problem",
    timeline: "Timeline",
    attempts: "Call attempts",
    noAttempts: "No call has been attempted on this ticket.",
    attempt: "Attempt",
    outcome: "Outcome",
    recording: "Recording",
    transcript: "Transcript",
    summary: "Summary",
    playback: "Play recording",
    nextAction: "Next action",
    owner: "Owner",
    unassigned: "Unassigned",
    noNextAction: "None set",
    resolution: "Resolution",
    confirmedBy: "Confirmed by",
    internal: "Internal",
    customerVisible: "Customer-visible",
    assuranceLevels: {
      none: "Not identified",
      channel_associated: "Phone associated with this contact",
      callback_confirmed: "Caller confirmed they requested the callback",
      verified: "Identity verified",
    },
    assuranceHint:
      "A phone association or a callback confirmation shows channel control, not verified identity.",
    outcomes: {
      queued: "Queued",
      dialing: "Dialing",
      answered: "Answered",
      no_answer: "No answer",
      busy: "Busy",
      voicemail: "Voicemail",
      refused: "Refused",
      cancelled: "Cancelled",
      disconnected: "Disconnected",
      provider_timeout: "Provider timeout",
      failed: "Failed",
    },
    recordingStates: {
      pending: "Not yet available",
      processing: "Processing",
      ready: "Ready",
      partial: "Partial",
      failed: "Failed",
      unavailable: "Unavailable",
    },
    summaryStates: {
      pending: "Not yet generated",
      processing: "Generating",
      ready: "Ready",
      failed: "Failed",
    },
    confirmations: {
      none: "Not confirmed",
      customer: "Customer confirmed",
      authoritative_evidence: "Authoritative evidence",
    },
    resolutions: {
      unknown: "Not yet known",
      unresolved: "Unresolved",
      proposed_fix_awaiting_confirmation: "Awaiting customer confirmation",
      resolved: "Resolved",
    },
  },
  he: {
    back: "כל הפניות",
    contact: "איש קשר",
    assurance: "זיהוי",
    problem: "הבעיה הנוכחית",
    timeline: "ציר זמן",
    attempts: "ניסיונות חיוג",
    noAttempts: "לא בוצע ניסיון חיוג בפנייה הזאת.",
    attempt: "ניסיון",
    outcome: "תוצאה",
    recording: "הקלטה",
    transcript: "תמלול",
    summary: "סיכום",
    playback: "השמעת ההקלטה",
    nextAction: "הפעולה הבאה",
    owner: "אחראי",
    unassigned: "לא שויך",
    noNextAction: "לא הוגדרה",
    resolution: "פתרון",
    confirmedBy: "אושר על ידי",
    internal: "פנימי",
    customerVisible: "גלוי ללקוח",
    assuranceLevels: {
      none: "לא זוהה",
      channel_associated: "הטלפון משויך לאיש הקשר",
      callback_confirmed: "המשיב אישר שביקש שיחה חוזרת",
      verified: "הזהות אומתה",
    },
    assuranceHint:
      "שיוך טלפון או אישור שיחה חוזרת מעידים על שליטה בערוץ, לא על זהות מאומתת.",
    outcomes: {
      queued: "בתור",
      dialing: "מחייג",
      answered: "נענתה",
      no_answer: "אין מענה",
      busy: "תפוס",
      voicemail: "תא קולי",
      refused: "סירוב",
      cancelled: "בוטלה",
      disconnected: "התנתקה",
      provider_timeout: "פסק זמן של הספק",
      failed: "נכשלה",
    },
    recordingStates: {
      pending: "עדיין לא זמינה",
      processing: "בעיבוד",
      ready: "מוכנה",
      partial: "חלקית",
      failed: "נכשלה",
      unavailable: "לא זמינה",
    },
    summaryStates: {
      pending: "עדיין לא הופק",
      processing: "בהפקה",
      ready: "מוכן",
      failed: "נכשל",
    },
    confirmations: {
      none: "לא אושר",
      customer: "הלקוח אישר",
      authoritative_evidence: "ראיה אמינה",
    },
    resolutions: {
      unknown: "עדיין לא ידוע",
      unresolved: "לא נפתרה",
      proposed_fix_awaiting_confirmation: "ממתינה לאישור הלקוח",
      resolved: "נפתרה",
    },
  },
} as const;

/** Only a verified object may be offered for playback. */
function playable(attempt: TicketCallAttempt): boolean {
  return (
    (attempt.recordingState === "ready" ||
      attempt.recordingState === "partial") &&
    attempt.recordingObjectId !== null
  );
}

export function TicketDetailView({
  detail,
  contactName,
  tenantTimeZone,
}: {
  readonly detail: TicketDetail;
  readonly contactName: string;
  readonly tenantTimeZone: string;
}) {
  const locale = useLocale();
  const t = COPY[locale.startsWith("he") ? "he" : "en"];
  const formatter = tenantDateFormatter(locale, tenantTimeZone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const { ticket, timeline, attempts } = detail;
  // The strongest assurance any attempt reached; an unattempted ticket has none.
  const assurance =
    attempts.find((attempt) => attempt.assuranceLevel === "verified")
      ?.assuranceLevel ??
    attempts.find((attempt) => attempt.assuranceLevel === "callback_confirmed")
      ?.assuranceLevel ??
    attempts[0]?.assuranceLevel ??
    "none";

  return (
    <section className={styles.workspace ?? ""}>
      <header className={styles.header ?? ""}>
        <div>
          <h1>{ticket.reference}</h1>
          <p>{ticket.subject}</p>
        </div>
        <Link className={styles.legacy ?? ""} href="/tickets">
          {t.back}
        </Link>
      </header>

      <dl className={styles.facts ?? ""}>
        <div>
          <dt>{t.contact}</dt>
          <dd>{contactName}</dd>
        </div>
        <div>
          <dt>{t.assurance}</dt>
          {/* Labelled precisely: low assurance is never shown as "verified". */}
          <dd>{t.assuranceLevels[assurance]}</dd>
        </div>
        <div>
          <dt>{t.resolution}</dt>
          <dd>{t.resolutions[ticket.resolutionClassification]}</dd>
        </div>
        <div>
          <dt>{t.confirmedBy}</dt>
          <dd>{t.confirmations[ticket.resolutionConfirmedBy]}</dd>
        </div>
        <div>
          <dt>{t.owner}</dt>
          <dd>{ticket.ownerUserId ?? t.unassigned}</dd>
        </div>
        <div>
          <dt>{t.nextAction}</dt>
          <dd>{ticket.nextAction ?? t.noNextAction}</dd>
        </div>
      </dl>
      <p className={styles.legacyHint ?? ""}>{t.assuranceHint}</p>

      <h2>{t.attempts}</h2>
      {attempts.length === 0 ? (
        <p className={styles.legacyHint ?? ""}>{t.noAttempts}</p>
      ) : (
        <table className={styles.table ?? ""}>
          <thead>
            <tr>
              <th scope="col">{t.attempt}</th>
              <th scope="col">{t.outcome}</th>
              <th scope="col">{t.recording}</th>
              <th scope="col">{t.summary}</th>
              <th scope="col">{t.transcript}</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((attempt) => (
              <tr key={attempt.id}>
                <td>{attempt.attemptNumber}</td>
                <td>{t.outcomes[attempt.outcome]}</td>
                <td>
                  {/* A stored object id is not a playable recording: the link
                      appears only once finalisation verified the media. */}
                  {playable(attempt) ? (
                    <Link
                      href={`/api/voice/recordings/${attempt.recordingObjectId ?? ""}`}
                    >
                      {t.playback}
                    </Link>
                  ) : (
                    t.recordingStates[attempt.recordingState]
                  )}
                </td>
                <td>{t.summaryStates[attempt.summaryState]}</td>
                <td>
                  {attempt.transcriptObjectId === null
                    ? t.recordingStates.unavailable
                    : t.recordingStates.ready}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{t.timeline}</h2>
      <ol className={styles.timeline ?? ""}>
        {timeline.map((entry) => (
          <li key={entry.sequence}>
            <span className={styles.timelineWhen ?? ""}>
              {formatter.format(new Date(entry.occurredAt))}
            </span>
            <span className={styles.timelineKind ?? ""}>{entry.kind}</span>
            <span>{entry.summarySafe}</span>
            <span className={styles.timelineVisibility ?? ""}>
              {entry.visibility === "customer_visible"
                ? t.customerVisible
                : t.internal}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
