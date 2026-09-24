"use client";

import type { InquiryDetail, TicketSummary } from "@or-on/crm";
import { Badge, Button } from "@or-on/ui";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import { csrfToken } from "../crm";
import { attentionTone, inquiryCopy } from "./inquiry-copy";
import styles from "./tickets-workspace.module.css";

const COPY = {
  en: {
    inquiry: "Inquiry details",
    source: "Source",
    sources: { voice: "Phone call", whatsapp: "WhatsApp" },
    status: "Intake status",
    missing: "Still missing",
    none: "Nothing",
    followup: "WhatsApp follow-up",
    followupError: "Follow-up error",
    replied: "Customer replied",
    media: "Customer photo/document received",
    communications: "Communications on this inquiry",
    noCommunications: "No WhatsApp messages are linked to this inquiry yet.",
    customer: "Customer",
    business: "Business",
    viewMedia: "Open attachment",
    toLink: "Replies that may belong to this inquiry",
    toLinkHint:
      "The customer has more than one open inquiry, so the reply was not attached automatically. Choose the inquiry it belongs to.",
    linkTo: (reference: string | null) => `Link to ${reference ?? "inquiry"}`,
    emergency: "Emergency",
    markEmergency: (label: string) => `Mark as ${label}`,
    reason: "Why is this urgent?",
    confirm: "Confirm",
    cancel: "Cancel",
    marked: (label: string, source: string) =>
      `${label} · ${source === "voice" ? "identified during the call" : "marked by staff"}`,
    failed: "The action could not be completed.",
  },
  he: {
    inquiry: "פרטי הפנייה",
    source: "מקור",
    sources: { voice: "שיחת טלפון", whatsapp: "WhatsApp" },
    status: "מצב קליטה",
    missing: "עדיין חסר",
    none: "אין",
    followup: "מעקב WhatsApp",
    followupError: "שגיאת מעקב",
    replied: "הלקוח השיב",
    media: "התקבלה תמונה/מסמך מהלקוח",
    communications: "תקשורת בפנייה זו",
    noCommunications: "עדיין לא שויכו הודעות WhatsApp לפנייה זו.",
    customer: "לקוח",
    business: "העסק",
    viewMedia: "פתיחת הקובץ",
    toLink: "תשובות שעשויות להשתייך לפנייה זו",
    toLinkHint:
      "ללקוח יש יותר מפנייה פתוחה אחת, ולכן התשובה לא שויכה אוטומטית. יש לבחור לאיזו פנייה היא שייכת.",
    linkTo: (reference: string | null) => `שיוך ל-${reference ?? "פנייה"}`,
    emergency: "חירום",
    markEmergency: (label: string) => `סימון כ${label}`,
    reason: "מה הסיבה לדחיפות?",
    confirm: "אישור",
    cancel: "ביטול",
    marked: (label: string, source: string) =>
      `${label} · ${source === "voice" ? "זוהתה במהלך השיחה" : "סומנה על ידי הצוות"}`,
    failed: "לא ניתן היה להשלים את הפעולה.",
  },
} as const;

async function post(url: string, body: unknown): Promise<string | null> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken(),
    },
    body: JSON.stringify(body),
  });
  if (response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  return payload.error ?? "failed";
}

export function InquiryPanel({
  ticket,
  inquiry,
  emergencyLabel,
  canMarkEmergency,
  tenantTimeZone,
}: {
  readonly ticket: TicketSummary;
  readonly inquiry: InquiryDetail | null;
  /** Tenant wording when emergencies are enabled; null hides the feature. */
  readonly emergencyLabel: string | null;
  readonly canMarkEmergency: boolean;
  readonly tenantTimeZone: string;
}) {
  const locale = useLocale();
  const t = COPY[locale.startsWith("he") ? "he" : "en"];
  const shared = inquiryCopy(locale);
  const formatter = tenantDateFormatter(locale, tenantTimeZone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const [reason, setReason] = useState("");
  const [marking, setMarking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = emergencyLabel ?? shared.emergencyFallback;

  async function act(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    const failure = await post(url, body);
    setBusy(false);
    if (failure !== null) {
      setError(failure === "failed" ? t.failed : failure);
      return;
    }
    setMarking(false);
    // The server re-reads the inquiry, timeline and audit state.
    window.location.reload();
  }

  return (
    <section aria-label={t.inquiry} className={styles.inquiry ?? ""}>
      {ticket.emergency !== null ? (
        <div className={styles.emergency ?? ""} role="status">
          {/* The label is text, never color alone. */}
          <Badge
            label={t.marked(label, ticket.emergency.source)}
            tone="critical"
          />
          <p dir="auto">{ticket.emergency.reason}</p>
          <small>{formatter.format(new Date(ticket.emergency.at))}</small>
        </div>
      ) : emergencyLabel !== null &&
        canMarkEmergency &&
        ticket.status === "open" ? (
        marking ? (
          <form
            className={styles.emergencyForm ?? ""}
            onSubmit={(event) => {
              event.preventDefault();
              void act(`/api/tickets/${ticket.id}/emergency`, { reason });
            }}
          >
            <label htmlFor="emergency-reason">{t.reason}</label>
            <textarea
              id="emergency-reason"
              maxLength={500}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              required
              rows={2}
              value={reason}
            />
            <div className={styles.actions ?? ""}>
              <Button disabled={busy || reason.trim() === ""} type="submit">
                {t.confirm}
              </Button>
              <Button
                onClick={() => {
                  setMarking(false);
                }}
                type="button"
                variant="secondary"
              >
                {t.cancel}
              </Button>
            </div>
          </form>
        ) : (
          <Button
            onClick={() => {
              setMarking(true);
            }}
            type="button"
            variant="secondary"
          >
            {t.markEmergency(label)}
          </Button>
        )
      ) : null}
      {error === null ? null : (
        <p className={styles.error ?? ""} role="alert">
          {error}
        </p>
      )}

      {inquiry === null ? null : (
        <>
          <h2>{t.inquiry}</h2>
          <dl className={styles.facts ?? ""}>
            <div>
              <dt>{t.source}</dt>
              <dd>{t.sources[inquiry.source]}</dd>
            </div>
            <div>
              <dt>{t.status}</dt>
              <dd>{inquiry.status}</dd>
            </div>
            {Object.entries(inquiry.fields).map(([key, value]) => (
              <div key={key}>
                <dt>{shared.fields[key] ?? key}</dt>
                <dd dir="auto">
                  {key === "urgency"
                    ? (shared.urgencies[value] ?? value)
                    : value}
                </dd>
              </div>
            ))}
            <div>
              <dt>{t.missing}</dt>
              <dd>
                {inquiry.missingFields.length === 0
                  ? t.none
                  : inquiry.missingFields
                      .map((field) => shared.fields[field] ?? field)
                      .join(", ")}
              </dd>
            </div>
            <div>
              <dt>{t.followup}</dt>
              <dd>
                {ticket.inquiry === null ? (
                  (shared.followupStatuses[inquiry.followupStatus] ??
                  inquiry.followupStatus)
                ) : (
                  <Badge
                    label={shared.attention[ticket.inquiry.attention]}
                    tone={attentionTone(ticket.inquiry.attention)}
                  />
                )}{" "}
                <small>
                  {shared.followupStatuses[inquiry.followupStatus] ??
                    inquiry.followupStatus}
                  {ticket.inquiry?.followupMessageStatus == null
                    ? ""
                    : ` · ${shared.messageStatuses[ticket.inquiry.followupMessageStatus] ?? ticket.inquiry.followupMessageStatus}`}
                </small>
              </dd>
            </div>
            {inquiry.followupError === null ? null : (
              <div>
                <dt>{t.followupError}</dt>
                <dd>{inquiry.followupError}</dd>
              </div>
            )}
            {inquiry.customerRepliedAt === null ? null : (
              <div>
                <dt>{t.replied}</dt>
                <dd>{formatter.format(new Date(inquiry.customerRepliedAt))}</dd>
              </div>
            )}
            {inquiry.customerMediaReceivedAt === null ? null : (
              <div>
                <dt>{t.media}</dt>
                <dd>
                  {formatter.format(new Date(inquiry.customerMediaReceivedAt))}
                </dd>
              </div>
            )}
          </dl>

          <h2>{t.communications}</h2>
          {inquiry.messages.length === 0 ? (
            <p className={styles.legacyHint ?? ""}>{t.noCommunications}</p>
          ) : (
            <ol className={styles.timeline ?? ""}>
              {inquiry.messages.map((message) => (
                <li key={message.messageId}>
                  <span className={styles.timelineWhen ?? ""}>
                    {formatter.format(new Date(message.at))}
                  </span>
                  <span className={styles.timelineKind ?? ""}>
                    {message.direction === "inbound" ? t.customer : t.business}
                  </span>
                  <span dir="auto">
                    {message.text ?? ""}
                    {message.hasMedia ? (
                      <>
                        {" "}
                        <Link
                          href={`/api/messaging/messages/${message.messageId}/media`}
                        >
                          {t.viewMedia}
                        </Link>
                      </>
                    ) : null}
                  </span>
                  <span className={styles.timelineVisibility ?? ""}>
                    {shared.messageStatuses[message.status] ?? message.status}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {inquiry.repliesToLink.length === 0 ? null : (
            <>
              <h2>{t.toLink}</h2>
              <p className={styles.legacyHint ?? ""}>{t.toLinkHint}</p>
              <ul className={styles.replyLinks ?? ""}>
                {inquiry.repliesToLink.map((reply) => (
                  <li key={reply.messageId}>
                    <span dir="auto">{reply.text ?? reply.contentType}</span>{" "}
                    <small>{formatter.format(new Date(reply.at))}</small>
                    <div className={styles.actions ?? ""}>
                      {reply.candidates.map((candidate) => (
                        <Button
                          disabled={busy}
                          key={candidate.intakeId}
                          onClick={() => {
                            void act(`/api/tickets/${ticket.id}/replies`, {
                              messageId: reply.messageId,
                              intakeId: candidate.intakeId,
                            });
                          }}
                          type="button"
                          variant="secondary"
                        >
                          {t.linkTo(candidate.reference)}
                        </Button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
