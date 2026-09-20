"use client";

import type {
  LeadDetail,
  LeadDetailField,
  LeadListEntry,
  LeadStatus,
} from "@or-on/crm";
import {
  Badge,
  Button,
  DataTable,
  Input,
  PageHeader,
  Select,
  Surface,
  Textarea,
} from "@or-on/ui";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import type { LeadTeamMember } from "./leads-workspace";
import styles from "./leads-workspace.module.css";

const COPY = {
  en: {
    title: "Lead record",
    overview: "Lead overview",
    back: "All leads",
    contact: "Contact",
    phone: "Phone",
    email: "Email",
    status: "Status",
    source: "Source",
    owner: "Owner",
    unassigned: "Unassigned",
    capturedBy: "Captured by",
    manualEntry: "Entered by hand",
    schema: "Field schema",
    noSchema: "No field schema pinned",
    capture: "Fields collected",
    noCapture: "No required fields to complete",
    objective: "Interest",
    created: "Created",
    updated: "Updated",
    revision: "Revision",
    nextAction: "Next action",
    noNextAction: "None set",
    due: "Due",
    summary: "Summary",
    noSummary: "No summary has been recorded.",
    conversation: "WhatsApp thread",
    openConversation: "Open the conversation",
    noConversation: "Not started from a conversation",
    calls: "Calls",
    noCalls: "No call is linked to this lead.",
    recording: "Recording",
    transcript: "Transcript",
    openCall: "Open the call record",
    available: "Available",
    missing: "Not available",
    fields: "Collected fields",
    field: "Field",
    value: "Value",
    state: "State",
    confirmation: "Confirmation",
    observed: "Observed",
    fieldSource: "Source",
    required: "Required",
    optional: "Optional",
    history: "Earlier values",
    noHistory: "No value on this lead has been superseded.",
    supersededAt: "Replaced",
    audit: "Activity",
    noAudit: "Nothing has been recorded against this lead yet.",
    actor: "By",
    system: "Automatic",
    manage: "Manage this lead",
    save: "Save changes",
    saving: "Saving…",
    saved: "Changes saved.",
    conflict:
      "Someone else changed this lead while you were editing it. Reload to see their version before saving again.",
    failed: "The change could not be saved.",
    editFields: "Correct collected fields",
    editHint:
      "A correction you type is recorded as verified by a person, keeps the earlier value in the history, and outranks any later automatic extraction of the same field.",
    fieldsSaved: "Fields saved.",
    noEdits: "Change a value before saving.",
    qualification: "Qualification evidence",
    noQualification: "No qualification evidence has been recorded.",
    captureHint:
      "Collection completeness is not sales qualification: a lead can have every field and still not be a fit.",
    provenanceHint:
      "Each value shows where it came from. Values captured by an agent are the agent's reading of what the customer said, not an independent verification.",
    states: {
      known: "Known",
      unknown: "Not yet known",
      declined: "Declined to say",
      not_applicable: "Not applicable",
    },
    confirmations: {
      unconfirmed: "Not confirmed",
      customer_confirmed: "Confirmed by the customer",
      human_verified: "Verified by a person",
    },
    recordedBy: { agent: "Agent", human: "Person", system: "System" },
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
      import: "Import",
    },
  },
  he: {
    title: "רשומת ליד",
    overview: "פרטי הליד",
    back: "כל הלידים",
    contact: "איש קשר",
    phone: "טלפון",
    email: "דוא״ל",
    status: "סטטוס",
    source: "מקור",
    owner: "אחראי",
    unassigned: "ללא אחראי",
    capturedBy: "נאסף על ידי",
    manualEntry: "הוזן ידנית",
    schema: "סכמת שדות",
    noSchema: "לא הוצמדה סכמת שדות",
    capture: "שדות שנאספו",
    noCapture: "אין שדות חובה להשלמה",
    objective: "תחום עניין",
    created: "נוצר",
    updated: "עודכן",
    revision: "גרסה",
    nextAction: "הפעולה הבאה",
    noNextAction: "לא הוגדרה",
    due: "עד",
    summary: "סיכום",
    noSummary: "לא נרשם סיכום.",
    conversation: "שיחת וואטסאפ",
    openConversation: "פתיחת השיחה",
    noConversation: "לא התחיל משיחה",
    calls: "שיחות",
    noCalls: "לא מקושרת שיחה לליד הזה.",
    recording: "הקלטה",
    transcript: "תמלול",
    openCall: "פתיחת רשומת השיחה",
    available: "קיימת",
    missing: "לא זמינה",
    fields: "שדות שנאספו",
    field: "שדה",
    value: "ערך",
    state: "מצב",
    confirmation: "אישור",
    observed: "נרשם",
    fieldSource: "מקור",
    required: "חובה",
    optional: "רשות",
    history: "ערכים קודמים",
    noHistory: "אף ערך בליד הזה לא הוחלף.",
    supersededAt: "הוחלף",
    audit: "פעילות",
    noAudit: "עדיין לא נרשמה פעילות על הליד הזה.",
    actor: "על ידי",
    system: "אוטומטי",
    manage: "ניהול הליד",
    save: "שמירת שינויים",
    saving: "שומר…",
    saved: "השינויים נשמרו.",
    conflict:
      "מישהו אחר שינה את הליד בזמן העריכה. רעננו כדי לראות את הגרסה שלו לפני שמירה נוספת.",
    failed: "לא הצלחנו לשמור את השינוי.",
    editFields: "תיקון שדות שנאספו",
    editHint:
      "תיקון שאתם מקלידים נרשם כמאומת על ידי אדם, שומר את הערך הקודם בהיסטוריה, וגובר על כל חילוץ אוטומטי מאוחר יותר של אותו שדה.",
    fieldsSaved: "השדות נשמרו.",
    noEdits: "שנו ערך לפני השמירה.",
    qualification: "ראיות להכשרה",
    noQualification: "לא נרשמו ראיות להכשרה.",
    captureHint:
      "שלמות האיסוף איננה הכשרה מסחרית: ליד יכול להיות מלא בכל השדות ועדיין לא להתאים.",
    provenanceHint:
      "לצד כל ערך מוצג מקורו. ערך שנאסף על ידי סוכן הוא מה שהסוכן הבין מדברי הלקוח, ולא אימות עצמאי.",
    states: {
      known: "ידוע",
      unknown: "עדיין לא ידוע",
      declined: "סירב למסור",
      not_applicable: "לא רלוונטי",
    },
    confirmations: {
      unconfirmed: "לא אושר",
      customer_confirmed: "אושר על ידי הלקוח",
      human_verified: "אומת על ידי אדם",
    },
    recordedBy: { agent: "סוכן", human: "אדם", system: "מערכת" },
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
      import: "ייבוא",
    },
  },
} as const;

/** `converted` is absent on purpose: it is set by a conversion, not a dropdown. */
const OPERATOR_STATUSES: readonly LeadStatus[] = [
  "new",
  "collecting",
  "ready_for_review",
  "qualified",
  "disqualified",
  "archived",
];

type Copy = (typeof COPY)["en"] | (typeof COPY)["he"];

function channelLabel(t: Copy, value: string | null): string {
  if (value === null) return "—";
  const labels = t.channels as Readonly<Record<string, string>>;
  return labels[value] ?? value;
}

/** A value is shown as the customer gave it, with the normalised form beside it. */
function FieldValue({ field }: { readonly field: LeadDetailField }) {
  if (field.state !== "known" || field.normalizedValue === null)
    return <span>—</span>;
  const shown =
    field.currency === null
      ? field.normalizedValue
      : `${field.normalizedValue} ${field.currency}`;
  return (
    <>
      <bdi>{shown}</bdi>
      {field.rawValue !== null && field.rawValue !== field.normalizedValue ? (
        <span className={styles.sources ?? ""}>
          {" "}
          (<bdi>{field.rawValue}</bdi>)
        </span>
      ) : null}
    </>
  );
}

export function LeadDetailView({
  detail,
  team,
  tenantTimeZone,
}: {
  readonly detail: LeadDetail;
  readonly team: readonly LeadTeamMember[];
  readonly tenantTimeZone: string;
}) {
  const locale = useLocale();
  const t = COPY[locale.startsWith("he") ? "he" : "en"];
  const router = useRouter();
  const formatter = tenantDateFormatter(locale, tenantTimeZone, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const [lead, setLead] = useState<LeadListEntry>(detail.lead);
  const [status, setStatus] = useState<LeadStatus>(detail.lead.status);
  const [owner, setOwner] = useState(detail.lead.ownerUserId ?? "");
  const [nextAction, setNextAction] = useState(detail.lead.nextAction ?? "");
  const [dueAt, setDueAt] = useState(
    detail.lead.nextActionDueAt === null
      ? ""
      : detail.lead.nextActionDueAt.slice(0, 10),
  );
  const [summary, setSummary] = useState(detail.lead.summary ?? "");
  const [edits, setEdits] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const completeness = lead.completeness;
  const done =
    completeness === null
      ? null
      : completeness.required.length - completeness.missing.length;

  async function saveManagement() {
    setPending(true);
    setNotice(null);
    setProblem(null);
    try {
      const response = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status,
          ownerUserId: owner === "" ? null : owner,
          nextAction: nextAction.trim() === "" ? null : nextAction,
          nextActionDueAt:
            dueAt === "" ? null : new Date(`${dueAt}T00:00:00`).toISOString(),
          summary: summary.trim() === "" ? null : summary,
          // The revision the operator actually read. A losing edit is refused
          // rather than quietly overwriting whoever saved first.
          expectedRevision: lead.revision,
        }),
      });
      if (response.status === 409) {
        setProblem(t.conflict);
        return;
      }
      if (!response.ok) throw new Error("lead update failed");
      const body = (await response.json()) as { readonly lead: LeadListEntry };
      setLead(body.lead);
      setNotice(t.saved);
      router.refresh();
    } catch {
      setProblem(t.failed);
    } finally {
      setPending(false);
    }
  }

  async function saveFields() {
    const changed = Object.entries(edits).filter(([key, value]) => {
      const current = detail.fields.find((field) => field.key === key);
      return value.trim() !== "" && value !== (current?.normalizedValue ?? "");
    });
    if (changed.length === 0) {
      setProblem(t.noEdits);
      return;
    }
    setPending(true);
    setNotice(null);
    setProblem(null);
    try {
      const response = await fetch(`/api/leads/${lead.id}/fields`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fields: changed.map(([key, value]) => ({
            key,
            state: "known",
            value,
          })),
          expectedRevision: lead.revision,
          // Stable across a resubmission of this exact set of corrections, so a
          // double click reconciles with the write it already made.
          operationKey: `lead-operator-${lead.id}-${String(lead.revision)}`,
        }),
      });
      if (response.status === 409) {
        setProblem(t.conflict);
        return;
      }
      if (!response.ok) {
        const body = (await response.json()) as { readonly error?: string };
        setProblem(body.error ?? t.failed);
        return;
      }
      setEdits({});
      setNotice(t.fieldsSaved);
      router.refresh();
    } catch {
      setProblem(t.failed);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader
        className="page-heading page-heading--premium"
        eyebrow={t.title}
        title={<bdi>{lead.reference}</bdi>}
        description={
          <bdi>{lead.businessObjective ?? lead.interestKey ?? t.objective}</bdi>
        }
        actions={
          <Link
            className="or-button or-button--secondary or-button--medium"
            href="/leads"
          >
            {t.back}
          </Link>
        }
      />
      <section className={styles.workspace ?? ""}>
        <Surface className={styles.detailPanel ?? ""} aria-label={t.overview}>
          <h2>{t.overview}</h2>
          <dl className={styles.facts ?? ""}>
            <div>
              <dt>{t.contact}</dt>
              <dd>
                <Link href={`/contacts/${detail.contact.id}`}>
                  <bdi>{detail.contact.name ?? detail.contact.id}</bdi>
                </Link>
              </dd>
            </div>
            <div>
              <dt>{t.phone}</dt>
              <dd>
                <bdi>{detail.contact.primaryPhone ?? "—"}</bdi>
              </dd>
            </div>
            <div>
              <dt>{t.email}</dt>
              <dd>
                <bdi>{detail.contact.email ?? "—"}</bdi>
              </dd>
            </div>
            <div>
              <dt>{t.status}</dt>
              <dd>
                <Badge label={t.statuses[lead.status]} />
              </dd>
            </div>
            <div>
              <dt>{t.source}</dt>
              <dd>{channelLabel(t, lead.sourceChannel)}</dd>
            </div>
            <div>
              <dt>{t.owner}</dt>
              <dd>{lead.ownerName ?? t.unassigned}</dd>
            </div>
            <div>
              {/* Provenance the operator can act on: which agent, at which frozen
              version, under which reviewed schema. Not a success score. */}
              <dt>{t.capturedBy}</dt>
              <dd>
                {lead.agentName === null
                  ? t.manualEntry
                  : `${lead.agentName} v${String(lead.agentVersion ?? 0)}`}
              </dd>
            </div>
            <div>
              <dt>{t.schema}</dt>
              <dd>
                {lead.fieldSchemaName === null
                  ? t.noSchema
                  : `${lead.fieldSchemaName} v${String(lead.fieldSchemaVersion ?? 0)}`}
              </dd>
            </div>
            <div>
              <dt>{t.capture}</dt>
              <dd>
                {completeness === null || done === null
                  ? t.noCapture
                  : `${String(done)}/${String(completeness.required.length)}`}
              </dd>
            </div>
            <div>
              <dt>{t.revision}</dt>
              <dd>{lead.revision}</dd>
            </div>
            <div>
              <dt>{t.created}</dt>
              <dd>{formatter.format(new Date(lead.createdAt))}</dd>
            </div>
            <div>
              <dt>{t.updated}</dt>
              <dd>{formatter.format(new Date(lead.updatedAt))}</dd>
            </div>
            <div>
              <dt>{t.conversation}</dt>
              <dd>
                {/* The Inbox selects a conversation by query parameter; there is no
                per-conversation route to link to. */}
                {detail.interaction.conversationId === null ? (
                  t.noConversation
                ) : (
                  <Link
                    href={`/inbox?conversation=${detail.interaction.conversationId}`}
                  >
                    {t.openConversation}
                  </Link>
                )}
              </dd>
            </div>
          </dl>
          <p className={styles.hint ?? ""}>{t.captureHint}</p>
        </Surface>

        <Surface className={styles.detailPanel ?? ""} aria-label={t.fields}>
          <h2>{t.fields}</h2>
          {detail.fields.length === 0 ? (
            <p className={styles.hint ?? ""}>{t.noSchema}</p>
          ) : (
            <div className={styles.directory ?? ""}>
              <DataTable label={t.fields}>
                <thead>
                  <tr>
                    <th scope="col">{t.field}</th>
                    <th scope="col">{t.value}</th>
                    <th scope="col">{t.state}</th>
                    <th scope="col">{t.confirmation}</th>
                    <th scope="col">{t.fieldSource}</th>
                    <th scope="col">{t.observed}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.fields.map((field) => (
                    <tr key={field.key}>
                      <td className={styles.identityCell ?? ""}>
                        {field.label}{" "}
                        <span className={styles.sources ?? ""}>
                          {field.required ? t.required : t.optional}
                        </span>
                      </td>
                      <td>
                        <span className={styles.cellLabel ?? ""}>
                          {t.value}
                        </span>
                        <FieldValue field={field} />
                      </td>
                      <td>
                        <span className={styles.cellLabel ?? ""}>
                          {t.state}
                        </span>
                        {field.state === null ? "—" : t.states[field.state]}
                      </td>
                      <td>
                        <span className={styles.cellLabel ?? ""}>
                          {t.confirmation}
                        </span>
                        {field.confirmation === null
                          ? "—"
                          : t.confirmations[field.confirmation]}
                      </td>
                      <td>
                        <span className={styles.cellLabel ?? ""}>
                          {t.fieldSource}
                        </span>
                        {field.recordedBy === null
                          ? "—"
                          : `${t.recordedBy[field.recordedBy]} · ${channelLabel(t, field.sourceChannel)}`}
                      </td>
                      <td>
                        <span className={styles.cellLabel ?? ""}>
                          {t.observed}
                        </span>
                        {field.observedAt === null
                          ? "—"
                          : formatter.format(new Date(field.observedAt))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </div>
          )}
          <p className={styles.hint ?? ""}>{t.provenanceHint}</p>
        </Surface>

        {detail.fields.length === 0 ? null : (
          <Surface
            className={styles.detailPanel ?? ""}
            aria-label={t.editFields}
          >
            <h2>{t.editFields}</h2>
            <p className={styles.hint ?? ""}>{t.editHint}</p>
            <div className={styles.editGrid ?? ""}>
              {detail.fields.map((field) =>
                field.type === "choice" && field.choices !== null ? (
                  <Select
                    id={`lead-field-${field.key}`}
                    key={field.key}
                    label={field.label}
                    onChange={(event) => {
                      setEdits((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }));
                    }}
                    value={edits[field.key] ?? field.normalizedValue ?? ""}
                  >
                    <option value="">—</option>
                    {field.choices.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={`lead-field-${field.key}`}
                    key={field.key}
                    label={field.label}
                    onChange={(event) => {
                      setEdits((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }));
                    }}
                    value={edits[field.key] ?? field.normalizedValue ?? ""}
                  />
                ),
              )}
            </div>
            <Button
              disabled={pending}
              onClick={() => {
                void saveFields();
              }}
              type="button"
            >
              {pending ? t.saving : t.save}
            </Button>
          </Surface>
        )}

        <Surface className={styles.detailPanel ?? ""} aria-label={t.manage}>
          <h2>{t.manage}</h2>
          <div className={styles.editGrid ?? ""}>
            <Select
              id="lead-status-edit"
              label={t.status}
              onChange={(event) => {
                setStatus(event.target.value as LeadStatus);
              }}
              value={status}
            >
              {OPERATOR_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t.statuses[value]}
                </option>
              ))}
            </Select>
            <Select
              id="lead-owner-edit"
              label={t.owner}
              onChange={(event) => {
                setOwner(event.target.value);
              }}
              value={owner}
            >
              <option value="">{t.unassigned}</option>
              {team.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
            </Select>
            <Input
              id="lead-next-action"
              label={t.nextAction}
              onChange={(event) => {
                setNextAction(event.target.value);
              }}
              value={nextAction}
            />
            <Input
              id="lead-due"
              label={t.due}
              onChange={(event) => {
                setDueAt(event.target.value);
              }}
              type="date"
              value={dueAt}
            />
          </div>
          <Textarea
            id="lead-summary"
            label={t.summary}
            onChange={(event) => {
              setSummary(event.target.value);
            }}
            rows={4}
            value={summary}
          />
          <Button
            disabled={pending}
            onClick={() => {
              void saveManagement();
            }}
            type="button"
          >
            {pending ? t.saving : t.save}
          </Button>
          {notice === null ? null : <p role="status">{notice}</p>}
          {problem === null ? null : <p role="alert">{problem}</p>}
        </Surface>

        <Surface
          className={styles.detailPanel ?? ""}
          aria-label={t.qualification}
        >
          <h2>{t.qualification}</h2>
          {Object.keys(detail.qualification).length === 0 ? (
            <p className={styles.hint ?? ""}>{t.noQualification}</p>
          ) : (
            <dl className={styles.facts ?? ""}>
              {Object.entries(detail.qualification).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>
                    <bdi>{JSON.stringify(value)}</bdi>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Surface>

        <Surface className={styles.detailPanel ?? ""} aria-label={t.calls}>
          <h2>{t.calls}</h2>
          {detail.calls.length === 0 ? (
            <p className={styles.hint ?? ""}>{t.noCalls}</p>
          ) : (
            <ul className={styles.timeline ?? ""}>
              {detail.calls.map((call) => (
                <li key={call.sessionId}>
                  <span className={styles.timelineWhen ?? ""}>
                    {call.startedAt === null
                      ? "—"
                      : formatter.format(new Date(call.startedAt))}
                  </span>
                  <span className={styles.timelineKind ?? ""}>
                    {call.direction ?? "—"} · {call.status ?? "—"}
                  </span>
                  <span>
                    {/* Stated from what is actually stored: a recording is listed
                      as available only when one exists to play. */}
                    {t.recording}:{" "}
                    {call.recording === "available" ? t.available : t.missing} ·{" "}
                    {t.transcript}:{" "}
                    {call.transcript === "available" ? t.available : t.missing}
                  </span>
                  <Link href={`/voice/calls/${call.sessionId}`}>
                    {t.openCall}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Surface>

        <Surface className={styles.detailPanel ?? ""} aria-label={t.history}>
          <h2>{t.history}</h2>
          {detail.history.length === 0 ? (
            <p className={styles.hint ?? ""}>{t.noHistory}</p>
          ) : (
            <ul className={styles.timeline ?? ""}>
              {detail.history.map((entry) => (
                <li key={`${entry.key}-${entry.observedAt}`}>
                  <span className={styles.timelineWhen ?? ""}>
                    {formatter.format(new Date(entry.observedAt))}
                  </span>
                  <span className={styles.timelineKind ?? ""}>{entry.key}</span>
                  <span>
                    <bdi>{entry.normalizedValue ?? t.states[entry.state]}</bdi>
                  </span>
                  <span className={styles.timelineVisibility ?? ""}>
                    {t.recordedBy[entry.recordedBy]}
                    {entry.supersededAt === null
                      ? ""
                      : ` · ${t.supersededAt} ${formatter.format(new Date(entry.supersededAt))}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Surface>

        <Surface className={styles.detailPanel ?? ""} aria-label={t.audit}>
          <h2>{t.audit}</h2>
          {detail.audit.length === 0 ? (
            <p className={styles.hint ?? ""}>{t.noAudit}</p>
          ) : (
            <ul className={styles.timeline ?? ""}>
              {detail.audit.map((entry) => (
                <li key={`${entry.action}-${entry.occurredAt}`}>
                  <span className={styles.timelineWhen ?? ""}>
                    {formatter.format(new Date(entry.occurredAt))}
                  </span>
                  <span className={styles.timelineKind ?? ""}>
                    {entry.action}
                  </span>
                  <span>
                    {t.actor}: {entry.actorName ?? t.system}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Surface>
      </section>
    </>
  );
}
