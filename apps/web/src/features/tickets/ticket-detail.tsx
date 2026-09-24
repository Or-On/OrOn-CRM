"use client";

import type {
  InquiryDetail,
  PostCallAnalysis,
  TicketCallAttempt,
  TicketDetail,
} from "@or-on/crm";
import { Badge, DataTable, PageHeader, Surface } from "@or-on/ui";
import { useLocale } from "next-intl";
import Link from "next/link";

import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import { inquiryCopy, nextActionLabel } from "./inquiry-copy";
import { InquiryPanel } from "./inquiry-panel";
import styles from "./tickets-workspace.module.css";

const COPY = {
  en: {
    title: "Ticket",
    inquiry: "Inquiry details",
    overview: "At a glance",
    details: "Ticket details",
    related: "Related channels",
    opened: "Opened",
    lastActivity: "Last activity",
    due: "Due",
    stage: "Stage",
    priority: "Priority",
    status: "Status",
    source: "Source channel",
    channels: { whatsapp: "WhatsApp", voice: "Voice", manual: "Manual" },
    events: {
      opened: "Opened",
      reopened: "Reopened",
      customer_message: "Customer message",
      agent_message: "Agent message",
      call_attempt: "Call attempt",
      call_outcome: "Call outcome",
      recording_state: "Recording",
      summary: "Summary",
      status_change: "Status change",
      assignment: "Assignment",
      human_note: "Internal note",
      customer_update: "Customer update",
      escalation: "Escalation",
      action_result: "Action result",
    },
    statuses: { open: "Open", closed: "Closed" },
    stages: {
      new: "New",
      ai_handling: "AI handling",
      callback_pending: "Callback pending",
      in_call: "On a call",
      awaiting_customer: "Awaiting customer",
      awaiting_human: "Awaiting human",
      closed: "Closed",
    },
    priorities: {
      low: "Low",
      normal: "Normal",
      high: "High",
      urgent: "Urgent",
    },
    back: "All tickets",
    contact: "Contact",
    assurance: "Identification",
    timeline: "Timeline",
    attempts: "Call attempts",
    noAttempts: "No call has been attempted on this ticket.",
    attempt: "Attempt",
    outcome: "Outcome",
    recording: "Recording",
    transcript: "Transcript",
    summary: "Call summary",
    playback: "Play recording",
    origin: "WhatsApp origin",
    openConversation: "Open the conversation",
    noConversation: "Not started from a conversation",
    voiceCall: "Voice call",
    openCall: "Open the call record",
    noCall: "No session yet",
    nextAction: "Next action",
    owner: "Owner",
    unassigned: "Unassigned",
    noNextAction: "None set",
    resolution: "Resolution",
    confirmedBy: "Confirmed by",
    handling: "Handling",
    internal: "Internal",
    customerVisible: "Customer-visible",
    issue: "Reported issue",
    facts: "Customer facts",
    attempted: "Actions attempted",
    completed: "Actions completed",
    unresolvedItems: "Still open",
    commitments: "Commitments made",
    evidence: "Evidence",
    confidence: "Classification confidence",
    noSummary: "No summary has been produced for this call.",
    summaryPending: "The call summary is still being produced.",
    summaryFailed: "The call summary could not be produced.",
    summaryNotApplicable: "There was no conversation to summarise.",
    completedHint:
      "Only actions with a platform receipt appear here. Anything the agent promised is listed under commitments.",
    followup: "WhatsApp follow-up",
    processing: "Processing",
    turns: "turns",
    seconds: "s",
    duration: "Duration",
    postCall: "Post-call processing",
    postCallError: "Last processing error",
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
      pending: "Recording processing",
      processing: "Recording processing",
      ready: "Recording ready",
      partial: "Partial recording",
      failed: "Recording unusable",
      unavailable: "Recording unavailable",
    },
    transcriptStates: {
      pending: "Transcript processing",
      valid: "Transcript ready",
      partial: "Partial transcript",
      empty: "Nothing was transcribed",
      missing: "Transcript unavailable",
      failed: "Transcript unusable",
    },
    summaryStates: {
      pending: "Not yet generated",
      processing: "Generating",
      ready: "Ready",
      failed: "Failed",
      not_applicable: "Not applicable",
    },
    followupStates: {
      not_required: "Not required",
      pending: "Queued",
      sent: "Sent",
      blocked_window: "Blocked: service window closed",
      blocked_consent: "Blocked: consent withdrawn",
      failed: "Failed",
    },
    postCallStages: {
      not_started: "Waiting for the call to end",
      artifacts_pending: "Verifying recording and transcript",
      artifacts_verified: "Artifacts verified",
      summary_pending: "Producing the summary",
      summary_ready: "Summary ready",
      ticket_updated: "Ticket updated",
      followup_pending: "Sending the follow-up",
      complete: "Complete",
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
    handlingModes: {
      ai_whatsapp: "AI · WhatsApp",
      ai_voice: "AI · Voice",
      human: "Human",
      paused: "Paused",
    },
    results: {
      succeeded: "succeeded",
      failed: "failed",
      unknown: "outcome unknown",
    },
    confidences: { high: "High", medium: "Medium", low: "Low" },
  },
  he: {
    title: "פנייה",
    inquiry: "פרטי הפנייה",
    overview: "במבט אחד",
    details: "פרטי הפנייה",
    related: "ערוצים קשורים",
    opened: "נפתחה",
    lastActivity: "פעילות אחרונה",
    due: "עד",
    stage: "שלב",
    priority: "עדיפות",
    status: "סטטוס",
    source: "ערוץ מקור",
    channels: { whatsapp: "וואטסאפ", voice: "קולי", manual: "ידני" },
    events: {
      opened: "נפתחה",
      reopened: "נפתחה מחדש",
      customer_message: "הודעת לקוח",
      agent_message: "הודעת נציג",
      call_attempt: "ניסיון חיוג",
      call_outcome: "תוצאת שיחה",
      recording_state: "הקלטה",
      summary: "סיכום",
      status_change: "שינוי סטטוס",
      assignment: "שיוך",
      human_note: "הערה פנימית",
      customer_update: "עדכון ללקוח",
      escalation: "הסלמה",
      action_result: "תוצאת פעולה",
    },
    statuses: { open: "פתוחה", closed: "סגורה" },
    stages: {
      new: "חדשה",
      ai_handling: "בטיפול AI",
      callback_pending: "ממתינה לחיוג",
      in_call: "בשיחה",
      awaiting_customer: "ממתינה ללקוח",
      awaiting_human: "ממתינה לנציג",
      closed: "סגורה",
    },
    priorities: {
      low: "נמוכה",
      normal: "רגילה",
      high: "גבוהה",
      urgent: "דחופה",
    },
    back: "כל הפניות",
    contact: "איש קשר",
    assurance: "זיהוי",
    timeline: "ציר זמן",
    attempts: "ניסיונות חיוג",
    noAttempts: "לא בוצע ניסיון חיוג בפנייה הזאת.",
    attempt: "ניסיון",
    outcome: "תוצאה",
    recording: "הקלטה",
    transcript: "תמלול",
    summary: "סיכום השיחה",
    playback: "השמעת ההקלטה",
    origin: "מקור בוואטסאפ",
    openConversation: "פתיחת השיחה",
    noConversation: "לא נפתחה משיחת וואטסאפ",
    voiceCall: "שיחה קולית",
    openCall: "פתיחת רישום השיחה",
    noCall: "עדיין אין שיחה",
    nextAction: "הפעולה הבאה",
    owner: "אחראי",
    unassigned: "לא שויך",
    noNextAction: "לא הוגדרה",
    resolution: "פתרון",
    confirmedBy: "אושר על ידי",
    handling: "טיפול",
    internal: "פנימי",
    customerVisible: "גלוי ללקוח",
    issue: "הבעיה שדווחה",
    facts: "עובדות מהלקוח",
    attempted: "פעולות שננסו",
    completed: "פעולות שבוצעו",
    unresolvedItems: "עדיין פתוח",
    commitments: "התחייבויות ללקוח",
    evidence: "ראיות",
    confidence: "ודאות הסיווג",
    noSummary: "לא הופק סיכום לשיחה הזאת.",
    summaryPending: "הסיכום עדיין בהפקה.",
    summaryFailed: "לא הצלחנו להפיק סיכום לשיחה.",
    summaryNotApplicable: "לא התקיימה שיחה שאפשר לסכם.",
    completedHint:
      "כאן מופיעות רק פעולות עם אישור מהמערכת. מה שהובטח ללקוח מופיע תחת התחייבויות.",
    followup: "הודעת סיכום בוואטסאפ",
    processing: "בעיבוד",
    turns: "תורות",
    seconds: "שנ׳",
    duration: "משך",
    postCall: "עיבוד לאחר השיחה",
    postCallError: "השגיאה האחרונה בעיבוד",
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
      pending: "ההקלטה בעיבוד",
      processing: "ההקלטה בעיבוד",
      ready: "ההקלטה מוכנה",
      partial: "הקלטה חלקית",
      failed: "ההקלטה אינה שמישה",
      unavailable: "אין הקלטה",
    },
    transcriptStates: {
      pending: "התמלול בעיבוד",
      valid: "התמלול מוכן",
      partial: "תמלול חלקי",
      empty: "לא תומלל דבר",
      missing: "אין תמלול",
      failed: "התמלול אינו שמיש",
    },
    summaryStates: {
      pending: "עדיין לא הופק",
      processing: "בהפקה",
      ready: "מוכן",
      failed: "נכשל",
      not_applicable: "לא רלוונטי",
    },
    followupStates: {
      not_required: "לא נדרשת",
      pending: "בתור",
      sent: "נשלחה",
      blocked_window: "נחסמה: חלון השירות נסגר",
      blocked_consent: "נחסמה: ההסכמה בוטלה",
      failed: "נכשלה",
    },
    postCallStages: {
      not_started: "ממתין לסיום השיחה",
      artifacts_pending: "מאמת הקלטה ותמלול",
      artifacts_verified: "הקבצים אומתו",
      summary_pending: "מפיק סיכום",
      summary_ready: "הסיכום מוכן",
      ticket_updated: "הפנייה עודכנה",
      followup_pending: "שולח הודעת סיכום",
      complete: "הושלם",
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
    handlingModes: {
      ai_whatsapp: "AI · וואטסאפ",
      ai_voice: "AI · קולי",
      human: "נציג",
      paused: "מושהית",
    },
    results: {
      succeeded: "הצליחה",
      failed: "נכשלה",
      unknown: "התוצאה אינה ידועה",
    },
    confidences: { high: "גבוהה", medium: "בינונית", low: "נמוכה" },
  },
} as const;

/**
 * Playback is offered only when the pipeline verified the bytes AND the call
 * has a session to stream them from.
 *
 * `recording_state` is written from a verification that opened the file, and the
 * playback route is keyed by session, so both are required: an object id with no
 * session would render a control that 404s, which is exactly the "a stored URI
 * implies a playable file" claim the states exist to prevent.
 */
function playable(attempt: TicketCallAttempt): attempt is TicketCallAttempt & {
  readonly sessionId: string;
} {
  return (
    (attempt.recordingState === "ready" ||
      attempt.recordingState === "partial") &&
    attempt.recordingObjectId !== null &&
    attempt.sessionId !== null
  );
}

function AnalysisPanel({
  analysis,
  t,
}: {
  readonly analysis: PostCallAnalysis;
  readonly t: (typeof COPY)["en"] | (typeof COPY)["he"];
}) {
  return (
    <div className={styles.analysis ?? ""}>
      <dl className={styles.facts ?? ""}>
        <div>
          <dt>{t.issue}</dt>
          <dd>{analysis.issue}</dd>
        </div>
        <div>
          <dt>{t.confidence}</dt>
          {/* Confidence in the CLASSIFICATION. Never presented as a score for
              how well the call went. */}
          <dd>{t.confidences[analysis.classificationConfidence]}</dd>
        </div>
      </dl>
      {analysis.customerFacts.length > 0 ? (
        <>
          <h3>{t.facts}</h3>
          <ul>
            {analysis.customerFacts.map((fact) => (
              <li key={fact.statement}>
                {fact.statement}
                <span className={styles.sources ?? ""}>
                  {" "}
                  ({t.evidence}:{" "}
                  {fact.sources
                    .map((source) => `${source.kind} ${source.reference}`)
                    .join(", ")}
                  )
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {analysis.actionsAttempted.length > 0 ? (
        <>
          <h3>{t.attempted}</h3>
          <ul>
            {analysis.actionsAttempted.map((action) => (
              <li key={action.action}>
                {action.action} — {t.results[action.result]}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>{t.completed}</h3>
      {analysis.actionsCompleted.length === 0 ? (
        <p className={styles.legacyHint ?? ""}>{t.completedHint}</p>
      ) : (
        <ul>
          {analysis.actionsCompleted.map((action) => (
            <li key={action.action}>
              {action.action}
              <span className={styles.sources ?? ""}>
                {" "}
                ({t.evidence}: {action.receipt.reference})
              </span>
            </li>
          ))}
        </ul>
      )}
      {analysis.commitments.length > 0 ? (
        <>
          <h3>{t.commitments}</h3>
          <ul>
            {analysis.commitments.map((item) => (
              <li key={item.statement}>{item.statement}</li>
            ))}
          </ul>
        </>
      ) : null}
      {analysis.unresolvedItems.length > 0 ? (
        <>
          <h3>{t.unresolvedItems}</h3>
          <ul>
            {analysis.unresolvedItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function TicketDetailView({
  detail,
  contactName,
  ownerName = null,
  tenantTimeZone,
  inquiry = null,
  emergencyLabel = null,
  canMarkEmergency = false,
}: {
  readonly detail: TicketDetail;
  readonly contactName: string;
  readonly ownerName?: string | null;
  readonly tenantTimeZone: string;
  readonly inquiry?: InquiryDetail | null;
  readonly emergencyLabel?: string | null;
  readonly canMarkEmergency?: boolean;
}) {
  const locale = useLocale();
  const shared = inquiryCopy(locale);
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
  const latest = attempts[0];
  const analysis =
    attempts.find((attempt) => attempt.analysis !== null)?.analysis ?? null;

  return (
    <>
      <PageHeader
        className="page-heading page-heading--premium"
        eyebrow={t.title}
        title={<bdi>{ticket.subject}</bdi>}
        description={<bdi dir="ltr">{ticket.reference}</bdi>}
        meta={
          <div className={styles.headerMeta}>
            <Badge
              label={`${t.stage}: ${t.stages[ticket.stage]}`}
              tone={
                ticket.stage === "closed"
                  ? "positive"
                  : ticket.stage === "awaiting_human" ||
                      ticket.stage === "callback_pending"
                    ? "warning"
                    : "info"
              }
            />
            <Badge
              label={`${t.priority}: ${t.priorities[ticket.priority]}`}
              tone={
                ticket.priority === "urgent"
                  ? "critical"
                  : ticket.priority === "high"
                    ? "warning"
                    : "neutral"
              }
            />
          </div>
        }
        actions={
          <Link
            className="or-button or-button--secondary or-button--medium"
            href="/tickets"
          >
            {t.back}
          </Link>
        }
      />

      <section className={styles.detailWorkspace}>
        <div className={styles.detailLayout}>
          <div className={styles.mainColumn}>
            <Surface
              as="section"
              className={styles.overviewCard}
              aria-label={t.overview}
              level="raised"
            >
              <div className={styles.sectionHeading}>
                <h2>{t.overview}</h2>
                <span className={styles.dateNote}>
                  {t.lastActivity}:{" "}
                  {formatter.format(new Date(ticket.lastActivityAt))}
                </span>
              </div>
              <dl className={styles.overviewFacts}>
                <div className={styles.nextActionFact}>
                  <dt>{t.nextAction}</dt>
                  <dd>
                    {nextActionLabel(shared, ticket.nextAction) ??
                      t.noNextAction}
                    {ticket.nextActionDueAt === null ? null : (
                      <span className={styles.dueNote}>
                        {t.due}:{" "}
                        {formatter.format(new Date(ticket.nextActionDueAt))}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t.owner}</dt>
                  <dd dir="auto">
                    {ticket.ownerUserId === null
                      ? t.unassigned
                      : (ownerName ?? ticket.ownerUserId)}
                  </dd>
                </div>
                <div>
                  <dt>{t.resolution}</dt>
                  <dd>{t.resolutions[ticket.resolutionClassification]}</dd>
                </div>
              </dl>
            </Surface>

            {inquiry !== null ||
            ticket.emergency !== null ||
            (emergencyLabel !== null &&
              canMarkEmergency &&
              ticket.status === "open") ? (
              <Surface
                as="section"
                className={styles.detailCard}
                aria-label={t.inquiry}
                level="raised"
              >
                <InquiryPanel
                  canMarkEmergency={canMarkEmergency}
                  emergencyLabel={emergencyLabel}
                  inquiry={inquiry}
                  tenantTimeZone={tenantTimeZone}
                  ticket={ticket}
                />
              </Surface>
            ) : null}

            <Surface
              as="section"
              className={styles.detailCard}
              aria-label={t.attempts}
              level="raised"
            >
              <h2>{t.attempts}</h2>
              {attempts.length === 0 ? (
                <p className={styles.emptyState}>{t.noAttempts}</p>
              ) : (
                <div className={styles.tableWrap}>
                  <DataTable label={t.attempts} minWidth="42rem">
                    <thead>
                      <tr>
                        <th scope="col">{t.attempt}</th>
                        <th scope="col">{t.outcome}</th>
                        <th scope="col">{t.recording}</th>
                        <th scope="col">{t.transcript}</th>
                        <th scope="col">{t.summary}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attempts.map((attempt) => (
                        <tr key={attempt.id}>
                          <td>{attempt.attemptNumber}</td>
                          <td>{t.outcomes[attempt.outcome]}</td>
                          <td>
                            <span>
                              {t.recordingStates[attempt.recordingState]}
                            </span>
                            {playable(attempt) ? (
                              <>
                                {" "}
                                <Link
                                  href={`/api/voice/sessions/${attempt.sessionId}/recording`}
                                >
                                  {t.playback}
                                </Link>
                              </>
                            ) : null}
                            {attempt.recordingDurationSeconds ===
                            null ? null : (
                              <span className={styles.sources}>
                                {" "}
                                ({t.duration}:{" "}
                                {Math.round(attempt.recordingDurationSeconds)}
                                {t.seconds})
                              </span>
                            )}
                          </td>
                          <td>
                            <span>
                              {t.transcriptStates[attempt.transcriptState]}
                            </span>
                            {attempt.transcriptTurnCount === null ||
                            attempt.transcriptTurnCount === 0 ? null : (
                              <span className={styles.sources}>
                                {" "}
                                ({attempt.transcriptTurnCount} {t.turns})
                              </span>
                            )}
                          </td>
                          <td>{t.summaryStates[attempt.summaryState]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                </div>
              )}
            </Surface>

            {latest === undefined ? null : (
              <Surface
                as="section"
                className={styles.detailCard}
                aria-label={t.summary}
                level="raised"
              >
                <h2>{t.summary}</h2>
                {analysis !== null ? (
                  <AnalysisPanel analysis={analysis} t={t} />
                ) : (
                  <p className={styles.emptyState}>
                    {latest.summaryState === "failed"
                      ? t.summaryFailed
                      : latest.summaryState === "not_applicable"
                        ? t.summaryNotApplicable
                        : latest.summaryState === "ready"
                          ? t.noSummary
                          : t.summaryPending}
                  </p>
                )}
              </Surface>
            )}

            <Surface
              as="section"
              className={styles.detailCard}
              aria-label={t.timeline}
              level="raised"
            >
              <h2>{t.timeline}</h2>
              <ol className={styles.timeline}>
                {timeline.map((entry) => (
                  <li key={entry.sequence}>
                    <span className={styles.timelineWhen}>
                      {formatter.format(new Date(entry.occurredAt))}
                    </span>
                    <span className={styles.timelineKind}>
                      {t.events[entry.kind]}
                    </span>
                    <span dir="auto">{entry.summarySafe}</span>
                    <span className={styles.timelineVisibility}>
                      {entry.visibility === "customer_visible"
                        ? t.customerVisible
                        : t.internal}
                    </span>
                  </li>
                ))}
              </ol>
            </Surface>
          </div>

          <aside className={styles.sideColumn}>
            <Surface
              as="section"
              className={styles.detailCard}
              aria-label={t.details}
              level="raised"
            >
              <h2>{t.details}</h2>
              <dl className={styles.detailFacts}>
                <div>
                  <dt>{t.contact}</dt>
                  <dd dir="auto">{contactName}</dd>
                </div>
                <div>
                  <dt>{t.status}</dt>
                  <dd>{t.statuses[ticket.status]}</dd>
                </div>
                <div>
                  <dt>{t.source}</dt>
                  <dd>{t.channels[ticket.sourceChannel]}</dd>
                </div>
                <div>
                  <dt>{t.opened}</dt>
                  <dd>{formatter.format(new Date(ticket.openedAt))}</dd>
                </div>
                <div>
                  <dt>{t.assurance}</dt>
                  {/* Labelled precisely: low assurance is never shown as "verified". */}
                  <dd>{t.assuranceLevels[assurance]}</dd>
                </div>
                <div>
                  <dt>{t.confirmedBy}</dt>
                  <dd>{t.confirmations[ticket.resolutionConfirmedBy]}</dd>
                </div>
                <div>
                  <dt>{t.handling}</dt>
                  <dd>{t.handlingModes[ticket.handlingMode]}</dd>
                </div>
              </dl>
              <p className={styles.assuranceHint}>{t.assuranceHint}</p>
            </Surface>

            <Surface
              as="section"
              className={styles.detailCard}
              aria-label={t.related}
              level="raised"
            >
              <h2>{t.related}</h2>
              <dl className={styles.detailFacts}>
                <div>
                  <dt>{t.origin}</dt>
                  <dd>
                    {/* The Inbox selects a conversation by query parameter; there is
                no per-conversation route to link to. */}
                    {ticket.sourceConversationId === null ? (
                      t.noConversation
                    ) : (
                      <Link
                        href={`/inbox?conversation=${ticket.sourceConversationId}`}
                      >
                        {t.openConversation}
                      </Link>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t.voiceCall}</dt>
                  <dd>
                    {/* The deeper call experience stays where it is; the ticket links
                to it rather than reimplementing it. */}
                    {latest?.sessionId == null ? (
                      t.noCall
                    ) : (
                      <Link href={`/voice/calls/${latest.sessionId}`}>
                        {t.openCall}
                      </Link>
                    )}
                  </dd>
                </div>
                {latest === undefined ? null : (
                  <div>
                    <dt>{t.postCall}</dt>
                    <dd>{t.postCallStages[latest.postCallStage]}</dd>
                  </div>
                )}
                {latest?.postCallErrorSafe == null ? null : (
                  <div>
                    <dt>{t.postCallError}</dt>
                    <dd>{latest.postCallErrorSafe}</dd>
                  </div>
                )}
                {latest === undefined ? null : (
                  <div>
                    <dt>{t.followup}</dt>
                    <dd>{t.followupStates[latest.followupState]}</dd>
                  </div>
                )}
              </dl>
            </Surface>
          </aside>
        </div>
      </section>
    </>
  );
}
