"use client";

import type {
  Ticket,
  TicketHandlingMode,
  TicketOutcomeMetrics,
  TicketPage,
  TicketPriority,
  TicketResolution,
  TicketSourceChannel,
  TicketStage,
  TicketStatus,
} from "@or-on/crm";
import { Button, Input, Select } from "@or-on/ui";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import styles from "./tickets-workspace.module.css";

const COPY = {
  en: {
    title: "Tickets",
    subtitle:
      "One customer issue, one ticket — every message, call and handover on it.",
    open: "Open",
    closed: "Closed",
    all: "All",
    allStages: "All stages",
    search: "Search reference, subject, contact or phone…",
    reference: "Reference",
    subject: "Subject",
    contact: "Contact",
    stage: "Stage",
    priority: "Priority",
    handling: "Handling",
    lastActivity: "Last activity",
    outcome: "Outcome",
    nextAction: "Next action",
    noNextAction: "None set",
    loadMore: "Load more",
    loading: "Loading…",
    empty: "No tickets match this view",
    emptyHint: "Change the status filter or clear the search.",
    failed: "Tickets could not be loaded.",
    retry: "Retry",
    legacyTasks: "Internal tasks",
    legacyHint: "Operational work items are still tracked under Tasks.",
    allPriorities: "Any priority",
    allChannels: "Any channel",
    allHandling: "Any handling",
    allResolutions: "Any outcome",
    resolution: "Outcome",
    channel: "Channel",
    metricsTitle: "AI resolution, last 30 days",
    metricsEmpty: "No AI-handled tickets were opened in this window.",
    metricsDefinition:
      "Confirmed AI-only resolution rate = tickets confirmed resolved with no human takeover ÷ eligible AI-handled tickets opened in the window. Duplicates and cancellations are excluded; nothing else is.",
    metricRate: "Confirmed AI-only",
    metricEligible: "Eligible tickets",
    metricAssisted: "AI-assisted resolved",
    metricEscalated: "Human escalated",
    metricAwaiting: "Awaiting confirmation",
    metricOpen: "Open unresolved",
    metricReopened: "Reopened after resolution",
    metricConfirmed: "Customer confirmed",
    metricMedian: "Median to resolution",
    metricP95: "p95 to resolution",
    metricRecordings: "Calls with a playable recording",
    minutes: "min",
    notAvailable: "—",
    channels: { whatsapp: "WhatsApp", voice: "Voice", manual: "Manual" },
    stages: {
      new: "New",
      ai_handling: "AI handling",
      callback_pending: "Callback pending",
      in_call: "On a call",
      awaiting_customer: "Awaiting customer",
      awaiting_human: "Awaiting human",
      closed: "Closed",
    },
    handlingModes: {
      ai_whatsapp: "AI · WhatsApp",
      ai_voice: "AI · Voice",
      human: "Human",
      paused: "Paused",
    },
    resolutions: {
      unknown: "Not yet known",
      unresolved: "Unresolved",
      proposed_fix_awaiting_confirmation: "Awaiting confirmation",
      resolved: "Resolved",
    },
    priorities: {
      low: "Low",
      normal: "Normal",
      high: "High",
      urgent: "Urgent",
    },
  },
  he: {
    title: "פניות",
    subtitle: "בעיה אחת של לקוח, פנייה אחת — כל הודעה, שיחה והעברה עליה.",
    open: "פתוחות",
    closed: "סגורות",
    all: "הכול",
    allStages: "כל השלבים",
    search: "חיפוש לפי מספר פנייה, נושא, איש קשר או טלפון…",
    reference: "מספר פנייה",
    subject: "נושא",
    contact: "איש קשר",
    stage: "שלב",
    priority: "עדיפות",
    handling: "טיפול",
    lastActivity: "פעילות אחרונה",
    outcome: "תוצאה",
    nextAction: "הפעולה הבאה",
    noNextAction: "לא הוגדרה",
    loadMore: "טעינת עוד",
    loading: "טוען…",
    empty: "אין פניות שמתאימות לתצוגה הזאת",
    emptyHint: "שנו את מסנן הסטטוס או נקו את החיפוש.",
    failed: "לא הצלחנו לטעון את הפניות.",
    retry: "נסו שוב",
    legacyTasks: "משימות פנימיות",
    legacyHint: "משימות תפעוליות ממשיכות להתנהל במסך המשימות.",
    allPriorities: "כל העדיפויות",
    allChannels: "כל הערוצים",
    allHandling: "כל סוגי הטיפול",
    allResolutions: "כל התוצאות",
    resolution: "תוצאה",
    channel: "ערוץ",
    metricsTitle: "פתרון על ידי ה‑AI, 30 הימים האחרונים",
    metricsEmpty: "לא נפתחו בחלון הזה פניות שטופלו על ידי ה‑AI.",
    metricsDefinition:
      "שיעור פתרון מאושר על ידי ה‑AI בלבד = פניות שנסגרו כפתורות עם אישור ובלי מעורבות אדם ÷ פניות זכאות שטופלו על ידי ה‑AI ונפתחו בחלון. כפילויות וביטולים אינם נספרים; שום דבר אחר לא מוחרג.",
    metricRate: "פתרון AI מאושר",
    metricEligible: "פניות זכאות",
    metricAssisted: "נפתרו בסיוע אדם",
    metricEscalated: "הועברו לנציג",
    metricAwaiting: "ממתינות לאישור",
    metricOpen: "פתוחות ולא נפתרו",
    metricReopened: "נפתחו מחדש אחרי פתרון",
    metricConfirmed: "אושרו על ידי הלקוח",
    metricMedian: "חציון עד פתרון",
    metricP95: "אחוזון 95 עד פתרון",
    metricRecordings: "שיחות עם הקלטה שניתן להשמיע",
    minutes: "דק׳",
    notAvailable: "—",
    channels: { whatsapp: "וואטסאפ", voice: "קולי", manual: "ידני" },
    stages: {
      new: "חדשה",
      ai_handling: "בטיפול AI",
      callback_pending: "ממתינה לחיוג",
      in_call: "בשיחה",
      awaiting_customer: "ממתינה ללקוח",
      awaiting_human: "ממתינה לנציג",
      closed: "סגורה",
    },
    handlingModes: {
      ai_whatsapp: "AI · וואטסאפ",
      ai_voice: "AI · קולי",
      human: "נציג",
      paused: "מושהית",
    },
    resolutions: {
      unknown: "עדיין לא ידוע",
      unresolved: "לא נפתרה",
      proposed_fix_awaiting_confirmation: "ממתינה לאישור הלקוח",
      resolved: "נפתרה",
    },
    priorities: {
      low: "נמוכה",
      normal: "רגילה",
      high: "גבוהה",
      urgent: "דחופה",
    },
  },
} as const;

const STAGES: readonly TicketStage[] = [
  "new",
  "ai_handling",
  "callback_pending",
  "in_call",
  "awaiting_customer",
  "awaiting_human",
  "closed",
];
const PRIORITIES: readonly TicketPriority[] = [
  "urgent",
  "high",
  "normal",
  "low",
];
const CHANNELS: readonly TicketSourceChannel[] = [
  "whatsapp",
  "voice",
  "manual",
];
const HANDLING: readonly TicketHandlingMode[] = [
  "ai_whatsapp",
  "ai_voice",
  "human",
  "paused",
];
const RESOLUTIONS: readonly TicketResolution[] = [
  "resolved",
  "proposed_fix_awaiting_confirmation",
  "unresolved",
  "unknown",
];

interface Cursor {
  readonly activityAt: string;
  readonly id: string;
}

function percent(numerator: number, denominator: number): string {
  return `${String(Math.round((numerator / denominator) * 1000) / 10)}%`;
}

/**
 * Aggregate outcomes, with the denominator and the exclusions on screen.
 *
 * This belongs on the register and nowhere near a single ticket. A per-ticket
 * percentage would be a score invented for one case; a rate over a stated
 * window with a stated denominator is a measurement someone can check.
 */
function OutcomeMetrics({
  metrics,
  t,
}: {
  readonly metrics: TicketOutcomeMetrics;
  readonly t: (typeof COPY)["en"] | (typeof COPY)["he"];
}) {
  const rate =
    metrics.eligible === 0
      ? null
      : percent(metrics.aiOnlyResolved, metrics.eligible);
  return (
    <section aria-label={t.metricsTitle}>
      <h2>{t.metricsTitle}</h2>
      {rate === null ? (
        <p className={styles.legacyHint ?? ""}>{t.metricsEmpty}</p>
      ) : (
        <dl className={styles.metrics ?? ""}>
          <div>
            <dt>{t.metricRate}</dt>
            {/* The fraction is shown beside the rate: a percentage without its
                denominator cannot be argued with, which is the problem. */}
            <dd>
              {rate}{" "}
              <span className={styles.sources ?? ""}>
                ({metrics.aiOnlyResolved}/{metrics.eligible})
              </span>
            </dd>
          </div>
          <div>
            <dt>{t.metricEligible}</dt>
            <dd>{metrics.eligible}</dd>
          </div>
          <div>
            <dt>{t.metricAssisted}</dt>
            <dd>{metrics.aiAssistedResolved}</dd>
          </div>
          <div>
            <dt>{t.metricEscalated}</dt>
            <dd>{metrics.humanEscalated}</dd>
          </div>
          <div>
            <dt>{t.metricAwaiting}</dt>
            <dd>{metrics.awaitingConfirmation}</dd>
          </div>
          <div>
            <dt>{t.metricOpen}</dt>
            <dd>{metrics.openUnresolved}</dd>
          </div>
          <div>
            <dt>{t.metricReopened}</dt>
            <dd>{metrics.reopenedAfterResolution}</dd>
          </div>
          <div>
            <dt>{t.metricConfirmed}</dt>
            <dd>{metrics.customerConfirmed}</dd>
          </div>
          <div>
            <dt>{t.metricMedian}</dt>
            <dd>
              {metrics.medianMinutesToResolution === null
                ? t.notAvailable
                : `${String(metrics.medianMinutesToResolution)} ${t.minutes}`}
            </dd>
          </div>
          <div>
            <dt>{t.metricP95}</dt>
            <dd>
              {metrics.p95MinutesToResolution === null
                ? t.notAvailable
                : `${String(metrics.p95MinutesToResolution)} ${t.minutes}`}
            </dd>
          </div>
          <div>
            <dt>{t.metricRecordings}</dt>
            <dd>
              {metrics.callAttempts === 0
                ? t.notAvailable
                : percent(
                    metrics.callsWithPlayableRecording,
                    metrics.callAttempts,
                  )}
            </dd>
          </div>
        </dl>
      )}
      <p className={styles.legacyHint ?? ""}>{t.metricsDefinition}</p>
    </section>
  );
}

export function TicketsWorkspace({
  initialPage,
  contactNames,
  tenantTimeZone,
  metrics,
}: {
  readonly initialPage: TicketPage;
  /** Resolved server-side; the browser never receives the contact table. */
  readonly contactNames: Readonly<Record<string, string>>;
  readonly tenantTimeZone: string;
  readonly metrics?: TicketOutcomeMetrics;
}) {
  const locale = useLocale();
  const t = COPY[locale.startsWith("he") ? "he" : "en"];
  const formatter = tenantDateFormatter(locale, tenantTimeZone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const [tickets, setTickets] = useState<readonly Ticket[]>(
    initialPage.tickets,
  );
  const [cursor, setCursor] = useState<Cursor | null>(initialPage.nextCursor);
  const [status, setStatus] = useState<TicketStatus | "all">("open");
  const [stage, setStage] = useState<TicketStage | "">("");
  const [priority, setPriority] = useState<TicketPriority | "">("");
  const [channel, setChannel] = useState<TicketSourceChannel | "">("");
  const [handling, setHandling] = useState<TicketHandlingMode | "">("");
  const [resolution, setResolution] = useState<TicketResolution | "">("");
  const [activeSince, setActiveSince] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    async (append: Cursor | null, signal?: AbortSignal) => {
      setBusy(true);
      setFailed(false);
      try {
        const parameters = new URLSearchParams({ status, limit: "25" });
        if (stage !== "") parameters.set("stage", stage);
        if (priority !== "") parameters.set("priority", priority);
        if (channel !== "") parameters.set("channel", channel);
        if (handling !== "") parameters.set("handling", handling);
        if (resolution !== "") parameters.set("resolution", resolution);
        // A date input is a local calendar day; the server filter is an
        // instant, so the day is anchored at its own start rather than now.
        if (activeSince !== "" && Number.isFinite(Date.parse(activeSince)))
          parameters.set(
            "activeSince",
            new Date(`${activeSince}T00:00:00`).toISOString(),
          );
        if (query.trim() !== "") parameters.set("q", query.trim());
        if (append !== null) {
          parameters.set("beforeActivityAt", append.activityAt);
          parameters.set("beforeId", append.id);
        }
        const response = await fetch(`/api/tickets?${parameters.toString()}`, {
          ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok) throw new Error("tickets request failed");
        const page = (await response.json()) as TicketPage;
        setTickets((current) =>
          append === null ? page.tickets : [...current, ...page.tickets],
        );
        setCursor(page.nextCursor);
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [
      activeSince,
      channel,
      handling,
      priority,
      query,
      resolution,
      stage,
      status,
    ],
  );

  // Filters re-query the server rather than filtering a client-side copy, so a
  // large tenant's queue is never loaded into the browser to be searched.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void load(null, controller.signal), 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  return (
    <section className={styles.workspace ?? ""}>
      <header className={styles.header ?? ""}>
        <div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
        <Link className={styles.legacy ?? ""} href="/tasks">
          {t.legacyTasks}
        </Link>
      </header>

      <div className={styles.filters ?? ""} role="group" aria-label={t.title}>
        <div className={styles.statusTabs ?? ""} role="tablist">
          {(["open", "closed", "all"] as const).map((value) => (
            <button
              aria-selected={status === value}
              className={styles.statusTab ?? ""}
              key={value}
              onClick={() => {
                setStatus(value);
              }}
              role="tab"
              type="button"
            >
              {t[value]}
            </button>
          ))}
        </div>
        <Select
          id="ticket-stage"
          label={t.stage}
          onChange={(event) => {
            setStage(event.target.value as TicketStage | "");
          }}
          value={stage}
        >
          <option value="">{t.allStages}</option>
          {STAGES.map((value) => (
            <option key={value} value={value}>
              {t.stages[value]}
            </option>
          ))}
        </Select>
        <Select
          id="ticket-priority"
          label={t.priority}
          onChange={(event) => {
            setPriority(event.target.value as TicketPriority | "");
          }}
          value={priority}
        >
          <option value="">{t.allPriorities}</option>
          {PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {t.priorities[value]}
            </option>
          ))}
        </Select>
        <Select
          id="ticket-channel"
          label={t.channel}
          onChange={(event) => {
            setChannel(event.target.value as TicketSourceChannel | "");
          }}
          value={channel}
        >
          <option value="">{t.allChannels}</option>
          {CHANNELS.map((value) => (
            <option key={value} value={value}>
              {t.channels[value]}
            </option>
          ))}
        </Select>
        <Select
          id="ticket-handling"
          label={t.handling}
          onChange={(event) => {
            setHandling(event.target.value as TicketHandlingMode | "");
          }}
          value={handling}
        >
          <option value="">{t.allHandling}</option>
          {HANDLING.map((value) => (
            <option key={value} value={value}>
              {t.handlingModes[value]}
            </option>
          ))}
        </Select>
        <Select
          id="ticket-resolution"
          label={t.resolution}
          onChange={(event) => {
            setResolution(event.target.value as TicketResolution | "");
          }}
          value={resolution}
        >
          <option value="">{t.allResolutions}</option>
          {RESOLUTIONS.map((value) => (
            <option key={value} value={value}>
              {t.resolutions[value]}
            </option>
          ))}
        </Select>
        <Input
          id="ticket-active-since"
          label={t.lastActivity}
          onChange={(event) => {
            setActiveSince(event.target.value);
          }}
          type="date"
          value={activeSince}
        />
        <Input
          id="ticket-search"
          label={t.search}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder={t.search}
          type="search"
          value={query}
        />
      </div>

      {metrics === undefined ? null : (
        <OutcomeMetrics metrics={metrics} t={t} />
      )}

      {failed ? (
        <div className={styles.empty ?? ""} role="alert">
          <p>{t.failed}</p>
          <Button
            onClick={() => {
              void load(null);
            }}
            type="button"
          >
            {t.retry}
          </Button>
        </div>
      ) : tickets.length === 0 && !busy ? (
        <div className={styles.empty ?? ""}>
          <p>{t.empty}</p>
          <p>{t.emptyHint}</p>
        </div>
      ) : (
        <table className={styles.table ?? ""}>
          <thead>
            <tr>
              <th scope="col">{t.reference}</th>
              <th scope="col">{t.subject}</th>
              <th scope="col">{t.contact}</th>
              <th scope="col">{t.stage}</th>
              <th scope="col">{t.priority}</th>
              <th scope="col">{t.handling}</th>
              <th scope="col">{t.outcome}</th>
              <th scope="col">{t.nextAction}</th>
              <th scope="col">{t.lastActivity}</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((ticket) => (
              <tr key={ticket.id}>
                <td>
                  <Link href={`/tickets/${ticket.id}`}>{ticket.reference}</Link>
                </td>
                <td>{ticket.subject}</td>
                <td>{contactNames[ticket.contactId] ?? ticket.contactId}</td>
                <td>{t.stages[ticket.stage]}</td>
                <td>{t.priorities[ticket.priority]}</td>
                <td>{t.handlingModes[ticket.handlingMode]}</td>
                <td>{t.resolutions[ticket.resolutionClassification]}</td>
                <td>{ticket.nextAction ?? t.noNextAction}</td>
                <td>{formatter.format(new Date(ticket.lastActivityAt))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {cursor !== null && !failed ? (
        <Button
          disabled={busy}
          onClick={() => {
            void load(cursor);
          }}
          type="button"
        >
          {busy ? t.loading : t.loadMore}
        </Button>
      ) : null}
      <p className={styles.legacyHint ?? ""}>{t.legacyHint}</p>
    </section>
  );
}
