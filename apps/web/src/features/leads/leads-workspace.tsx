"use client";

import type {
  LeadAgentFilter,
  LeadCounts,
  LeadListEntry,
  LeadPage,
  LeadSortKey,
  LeadSourceChannel,
  LeadStatus,
} from "@or-on/crm";
import { Button, Input, Select } from "@or-on/ui";
import { useLocale } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import styles from "./leads-workspace.module.css";

export interface LeadTeamMember {
  readonly userId: string;
  readonly name: string;
}

const COPY = {
  en: {
    title: "Leads",
    subtitle:
      "Commercial interest captured by agents, with the fields collected for each one.",
    open: "Open",
    all: "All",
    search: "Search reference, objective, contact or phone…",
    reference: "Reference",
    contact: "Contact",
    objective: "Interest",
    status: "Status",
    source: "Source",
    owner: "Owner",
    agent: "Captured by",
    capture: "Fields collected",
    nextAction: "Next action",
    updated: "Updated",
    created: "Created",
    due: "Next action due",
    sort: "Sort by",
    anyStatus: "Any status",
    anyChannel: "Any source",
    anyOwner: "Any owner",
    anyAgent: "Any agent",
    unassigned: "Unassigned",
    noOwner: "Unassigned",
    noNextAction: "None set",
    noAgent: "Manual entry",
    since: "Updated since",
    loadMore: "Load more",
    loading: "Loading…",
    empty: "No leads match this view",
    emptyHint: "Change the filters or clear the search.",
    failed: "Leads could not be loaded.",
    retry: "Retry",
    matching: "{count} matching",
    noSchema: "No field schema",
    completeness: "{done} of {total} required fields",
    captureHint:
      "Fields collected counts required fields in the schema pinned to each lead, counting an explicit refusal as answered. It is a completeness measure, not a sales forecast and not an agent score.",
    statuses: {
      new: "New",
      collecting: "Collecting",
      ready_for_review: "Ready for review",
      qualified: "Qualified",
      disqualified: "Disqualified",
      converted: "Converted",
      archived: "Archived",
    },
    channels: {
      voice: "Voice",
      whatsapp: "WhatsApp",
      manual: "Manual",
      api: "API",
    },
  },
  he: {
    title: "לידים",
    subtitle: "התעניינות עסקית שנאספה על ידי הסוכנים, עם השדות שנאספו לכל אחת.",
    open: "פתוחים",
    all: "הכול",
    search: "חיפוש לפי מספר ליד, תחום עניין, איש קשר או טלפון…",
    reference: "מספר ליד",
    contact: "איש קשר",
    objective: "תחום עניין",
    status: "סטטוס",
    source: "מקור",
    owner: "אחראי",
    agent: "נאסף על ידי",
    capture: "שדות שנאספו",
    nextAction: "הפעולה הבאה",
    updated: "עודכן",
    created: "נוצר",
    due: "מועד הפעולה הבאה",
    sort: "מיון לפי",
    anyStatus: "כל הסטטוסים",
    anyChannel: "כל המקורות",
    anyOwner: "כל האחראים",
    anyAgent: "כל הסוכנים",
    unassigned: "ללא אחראי",
    noOwner: "ללא אחראי",
    noNextAction: "לא הוגדרה",
    noAgent: "הוזן ידנית",
    since: "עודכן מאז",
    loadMore: "טעינת עוד",
    loading: "טוען…",
    empty: "אין לידים שמתאימים לתצוגה הזאת",
    emptyHint: "שנו את המסננים או נקו את החיפוש.",
    failed: "לא הצלחנו לטעון את הלידים.",
    retry: "נסו שוב",
    matching: "{count} תואמים",
    noSchema: "אין סכמת שדות",
    completeness: "{done} מתוך {total} שדות חובה",
    captureHint:
      "‏״שדות שנאספו״ סופר שדות חובה בסכמה שמוצמדת לכל ליד, וסירוב מפורש נספר כתשובה. זהו מדד שלמות איסוף — לא תחזית מכירה ולא ציון לסוכן.",
    statuses: {
      new: "חדש",
      collecting: "באיסוף",
      ready_for_review: "מוכן לבדיקה",
      qualified: "מוכשר",
      disqualified: "נפסל",
      converted: "הומר",
      archived: "בארכיון",
    },
    channels: {
      voice: "קולי",
      whatsapp: "וואטסאפ",
      manual: "ידני",
      api: "ממשק",
    },
  },
} as const;

const STATUSES: readonly LeadStatus[] = [
  "new",
  "collecting",
  "ready_for_review",
  "qualified",
  "disqualified",
  "converted",
  "archived",
];
const CHANNELS: readonly LeadSourceChannel[] = [
  "whatsapp",
  "voice",
  "manual",
  "api",
];
const SORTS: readonly LeadSortKey[] = ["updated", "created", "due"];

interface Cursor {
  readonly sortAt: string;
  readonly id: string;
}

interface Filters {
  readonly status: LeadStatus | "all" | "open";
  readonly channel: LeadSourceChannel | "";
  readonly owner: string;
  readonly agent: string;
  readonly since: string;
  readonly sort: LeadSortKey;
  readonly query: string;
}

function filtersFromSearch(parameters: URLSearchParams): Filters {
  const status = parameters.get("status") ?? "open";
  const channel = parameters.get("channel") ?? "";
  const sort = parameters.get("sort") ?? "updated";
  return {
    status:
      status === "all" || (STATUSES as readonly string[]).includes(status)
        ? (status as LeadStatus | "all")
        : "open",
    channel: (CHANNELS as readonly string[]).includes(channel)
      ? (channel as LeadSourceChannel)
      : "",
    owner: parameters.get("owner") ?? "",
    agent: parameters.get("agent") ?? "",
    since: parameters.get("since") ?? "",
    sort: (SORTS as readonly string[]).includes(sort)
      ? (sort as LeadSortKey)
      : "updated",
    query: parameters.get("q") ?? "",
  };
}

/** The URL is the single source of truth, so a reload restores the same view. */
function searchFromFilters(filters: Filters): URLSearchParams {
  const parameters = new URLSearchParams();
  if (filters.status !== "open") parameters.set("status", filters.status);
  if (filters.channel !== "") parameters.set("channel", filters.channel);
  if (filters.owner !== "") parameters.set("owner", filters.owner);
  if (filters.agent !== "") parameters.set("agent", filters.agent);
  if (filters.since !== "") parameters.set("since", filters.since);
  if (filters.sort !== "updated") parameters.set("sort", filters.sort);
  if (filters.query.trim() !== "") parameters.set("q", filters.query.trim());
  return parameters;
}

function requestParameters(filters: Filters): URLSearchParams {
  const parameters = new URLSearchParams({
    status: filters.status,
    sort: filters.sort,
    limit: "25",
  });
  if (filters.channel !== "") parameters.set("channel", filters.channel);
  if (filters.owner === "none") parameters.set("unassigned", "true");
  else if (filters.owner !== "") parameters.set("ownerUserId", filters.owner);
  if (filters.agent !== "")
    parameters.set("agentProfileVersionId", filters.agent);
  // A date input is a local calendar day; the server filter is an instant, so
  // the day is anchored at its own start rather than at the current time.
  if (filters.since !== "" && Number.isFinite(Date.parse(filters.since)))
    parameters.set(
      "since",
      new Date(`${filters.since}T00:00:00`).toISOString(),
    );
  if (filters.query.trim() !== "") parameters.set("q", filters.query.trim());
  return parameters;
}

function Completeness({
  lead,
  noSchema,
  template,
}: {
  readonly lead: LeadListEntry;
  readonly noSchema: string;
  readonly template: string;
}) {
  if (lead.completeness === null) return <span>{noSchema}</span>;
  const total = lead.completeness.required.length;
  const done = total - lead.completeness.missing.length;
  return (
    <span>
      {template
        .replace("{done}", String(done))
        .replace("{total}", String(total))}
    </span>
  );
}

export function LeadsWorkspace({
  initialPage,
  initialCounts,
  team,
  agents,
  tenantTimeZone,
}: {
  readonly initialPage: LeadPage;
  readonly initialCounts: LeadCounts;
  readonly team: readonly LeadTeamMember[];
  readonly agents: readonly LeadAgentFilter[];
  readonly tenantTimeZone: string;
}) {
  const locale = useLocale();
  const t = COPY[locale.startsWith("he") ? "he" : "en"];
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const formatter = tenantDateFormatter(locale, tenantTimeZone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const [filters, setFilters] = useState<Filters>(() =>
    filtersFromSearch(new URLSearchParams(search.toString())),
  );
  const [leads, setLeads] = useState<readonly LeadListEntry[]>(
    initialPage.leads,
  );
  const [cursor, setCursor] = useState<Cursor | null>(initialPage.nextCursor);
  const [counts, setCounts] = useState<LeadCounts>(initialCounts);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    async (append: Cursor | null, signal?: AbortSignal) => {
      setBusy(true);
      setFailed(false);
      try {
        const parameters = requestParameters(filters);
        if (append !== null) {
          parameters.set("beforeSortAt", append.sortAt);
          parameters.set("beforeId", append.id);
        }
        const response = await fetch(`/api/leads?${parameters.toString()}`, {
          ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok) throw new Error("leads request failed");
        const page = (await response.json()) as LeadPage & {
          readonly counts: LeadCounts;
        };
        setLeads((current) =>
          append === null ? page.leads : [...current, ...page.leads],
        );
        setCursor(page.nextCursor);
        setCounts(page.counts);
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [filters],
  );

  // Filters re-query the server and are mirrored into the URL, so the register
  // is never filtered in the browser and a reload lands on the same view.
  useEffect(() => {
    const controller = new AbortController();
    const parameters = searchFromFilters(filters).toString();
    const timer = setTimeout(() => {
      router.replace(
        parameters === "" ? pathname : `${pathname}?${parameters}`,
        {
          scroll: false,
        },
      );
      void load(null, controller.signal);
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filters, load, pathname, router]);

  const update = (change: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...change }));
  };

  return (
    <section className={styles.workspace ?? ""}>
      <header className={styles.header ?? ""}>
        <div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
        <p className={styles.count ?? ""}>
          {t.matching.replace("{count}", String(counts.total))}
        </p>
      </header>

      <div className={styles.filters ?? ""} role="group" aria-label={t.title}>
        <div className={styles.statusTabs ?? ""} role="tablist">
          {(["open", "all"] as const).map((value) => (
            <button
              aria-selected={filters.status === value}
              className={styles.statusTab ?? ""}
              key={value}
              onClick={() => {
                update({ status: value });
              }}
              role="tab"
              type="button"
            >
              {t[value]}
            </button>
          ))}
        </div>
        <Select
          id="lead-status"
          label={t.status}
          onChange={(event) => {
            update({
              status: event.target.value as LeadStatus | "all" | "open",
            });
          }}
          value={filters.status}
        >
          <option value="open">{t.open}</option>
          <option value="all">{t.anyStatus}</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {/* Each badge counts the same set the tab would show, because the
                  server applies one predicate to the rows and the counts. */}
              {t.statuses[value]} ({counts.byStatus[value]})
            </option>
          ))}
        </Select>
        <Select
          id="lead-channel"
          label={t.source}
          onChange={(event) => {
            update({ channel: event.target.value as LeadSourceChannel | "" });
          }}
          value={filters.channel}
        >
          <option value="">{t.anyChannel}</option>
          {CHANNELS.map((value) => (
            <option key={value} value={value}>
              {t.channels[value]}
            </option>
          ))}
        </Select>
        <Select
          id="lead-owner"
          label={t.owner}
          onChange={(event) => {
            update({ owner: event.target.value });
          }}
          value={filters.owner}
        >
          <option value="">{t.anyOwner}</option>
          <option value="none">{t.unassigned}</option>
          {team.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </Select>
        <Select
          id="lead-agent"
          label={t.agent}
          onChange={(event) => {
            update({ agent: event.target.value });
          }}
          value={filters.agent}
        >
          <option value="">{t.anyAgent}</option>
          {agents.map((agent) => (
            <option
              key={agent.agentProfileVersionId}
              value={agent.agentProfileVersionId}
            >
              {agent.name} v{agent.version}
            </option>
          ))}
        </Select>
        <Select
          id="lead-sort"
          label={t.sort}
          onChange={(event) => {
            update({ sort: event.target.value as LeadSortKey });
          }}
          value={filters.sort}
        >
          {SORTS.map((value) => (
            <option key={value} value={value}>
              {t[value]}
            </option>
          ))}
        </Select>
        <Input
          id="lead-since"
          label={t.since}
          onChange={(event) => {
            update({ since: event.target.value });
          }}
          type="date"
          value={filters.since}
        />
        <Input
          id="lead-search"
          label={t.search}
          onChange={(event) => {
            update({ query: event.target.value });
          }}
          placeholder={t.search}
          type="search"
          value={filters.query}
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
      ) : leads.length === 0 && !busy ? (
        <div className={styles.empty ?? ""}>
          <p>{t.empty}</p>
          <p>{t.emptyHint}</p>
        </div>
      ) : (
        <table className={styles.table ?? ""}>
          <thead>
            <tr>
              <th scope="col">{t.reference}</th>
              <th scope="col">{t.contact}</th>
              <th scope="col">{t.objective}</th>
              <th scope="col">{t.status}</th>
              <th scope="col">{t.source}</th>
              <th scope="col">{t.owner}</th>
              <th scope="col">{t.agent}</th>
              <th scope="col">{t.capture}</th>
              <th scope="col">{t.nextAction}</th>
              <th scope="col">{t.updated}</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>
                  {/* A reference is a Latin identifier inside a Hebrew page;
                      isolating it keeps the surrounding text ordered. */}
                  <Link href={`/leads/${lead.id}`}>
                    <bdi>{lead.reference}</bdi>
                  </Link>
                </td>
                <td>
                  <Link href={`/contacts/${lead.contactId}`}>
                    {lead.contactName ?? lead.contactId}
                  </Link>
                </td>
                <td>{lead.businessObjective ?? lead.interestKey ?? "—"}</td>
                <td>{t.statuses[lead.status]}</td>
                <td>{t.channels[lead.sourceChannel]}</td>
                <td>{lead.ownerName ?? t.noOwner}</td>
                <td>
                  {lead.agentName === null
                    ? t.noAgent
                    : `${lead.agentName} v${String(lead.agentVersion ?? 0)}`}
                </td>
                <td>
                  <Completeness
                    lead={lead}
                    noSchema={t.noSchema}
                    template={t.completeness}
                  />
                </td>
                <td>{lead.nextAction ?? t.noNextAction}</td>
                <td>{formatter.format(new Date(lead.updatedAt))}</td>
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
      <p className={styles.hint ?? ""}>{t.captureHint}</p>
    </section>
  );
}
