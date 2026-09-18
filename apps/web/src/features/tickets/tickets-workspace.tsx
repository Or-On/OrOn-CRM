"use client";

import type { Ticket, TicketPage, TicketStage, TicketStatus } from "@or-on/crm";
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

interface Cursor {
  readonly activityAt: string;
  readonly id: string;
}

export function TicketsWorkspace({
  initialPage,
  contactNames,
  tenantTimeZone,
}: {
  readonly initialPage: TicketPage;
  /** Resolved server-side; the browser never receives the contact table. */
  readonly contactNames: Readonly<Record<string, string>>;
  readonly tenantTimeZone: string;
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
    [query, stage, status],
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
