/**
 * Operator-facing reads and edits for the Leads workspace.
 *
 * Separate from `leads.ts` on purpose. That module is the interaction-scoped
 * mutation authority: every write there is bound to one contact and one live
 * conversation, and a lead belonging to someone else is invisible to it. This
 * module is the tenant-scoped operator surface: a person with `crm:read` may
 * list every lead in the workspace, and a person with `crm:write` may correct
 * one. The two must not be collapsed, because the guard that protects a
 * customer from an agent reaching another customer's lead is exactly the guard
 * an operator legitimately works without.
 *
 * Every filter here is applied in PostgreSQL. The list and the count share one
 * predicate builder so a filtered count can never describe a different set
 * from the rows beneath it, and neither one can be satisfied by shipping the
 * tenant's lead history to a browser.
 */
import type postgres from "postgres";

import {
  leadCompleteness,
  parseLeadFieldSchema,
  type LeadCompleteness,
  type LeadFieldConfirmation,
  type LeadFieldSchema,
  type LeadFieldState,
  type LeadFieldType,
} from "./lead-schema.js";
import {
  leadStatuses,
  type LeadBinding,
  type LeadRecordedBy,
  type LeadSourceChannel,
  type LeadStatus,
} from "./leads.js";
import type { JsonValue } from "./types.js";

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

function identifier(value: string, name: string): string {
  if (!uuidPattern.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function optionalIdentifier(
  value: string | null | undefined,
  name: string,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return identifier(value.trim(), name);
}

function databaseJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export const leadSortKeys = ["updated", "created", "due"] as const;
export type LeadSortKey = (typeof leadSortKeys)[number];

export interface LeadListOptions {
  /** `all` includes archived and converted leads; the default hides neither. */
  readonly status?: LeadStatus | "all" | "open";
  readonly sourceChannel?: LeadSourceChannel;
  readonly ownerUserId?: string;
  /** `unassigned` is a real filter, not the absence of one. */
  readonly unassigned?: boolean;
  readonly agentProfileVersionId?: string;
  readonly contactId?: string;
  readonly query?: string;
  /** Inclusive lower bound on the sort column. */
  readonly since?: string;
  /** Exclusive upper bound on the sort column. */
  readonly until?: string;
  readonly sort?: LeadSortKey;
  readonly limit?: number;
  readonly beforeSortAt?: string;
  readonly beforeId?: string;
}

export interface LeadListEntry {
  readonly id: string;
  readonly reference: string;
  readonly status: LeadStatus;
  readonly contactId: string;
  readonly contactName: string | null;
  readonly ownerUserId: string | null;
  readonly ownerName: string | null;
  readonly sourceChannel: LeadSourceChannel;
  readonly businessObjective: string | null;
  readonly interestKey: string | null;
  readonly summary: string | null;
  readonly nextAction: string | null;
  readonly nextActionDueAt: string | null;
  readonly agentProfileVersionId: string | null;
  /** Provenance an operator can act on: which agent, at which published version. */
  readonly agentName: string | null;
  readonly agentVersion: number | null;
  readonly fieldSchemaName: string | null;
  readonly fieldSchemaVersion: number | null;
  /**
   * Collection completeness only. This is not a sales probability and is not
   * an "AI success rate": it counts required fields that have an answer,
   * including an explicit refusal, against required fields in the pinned
   * schema. Null when the lead has no schema pinned, because there is then no
   * denominator to be complete against.
   */
  readonly completeness: LeadCompleteness | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly convertedDealId: string | null;
}

export interface LeadPage {
  readonly leads: readonly LeadListEntry[];
  readonly nextCursor: {
    readonly sortAt: string;
    readonly id: string;
  } | null;
}

interface LeadListRow {
  readonly id: string;
  readonly reference: string;
  readonly status: LeadStatus;
  readonly contact_id: string;
  readonly contact_name: string | null;
  readonly owner_user_id: string | null;
  readonly owner_name: string | null;
  readonly source_channel: LeadSourceChannel;
  readonly business_objective: string | null;
  readonly interest_key: string | null;
  readonly summary: string | null;
  readonly next_action: string | null;
  readonly next_action_due_at: Date | null;
  readonly agent_profile_version_id: string | null;
  readonly agent_name: string | null;
  readonly agent_version: number | null;
  readonly field_schema_id: string | null;
  readonly field_schema_name: string | null;
  readonly field_schema_version: number | null;
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly archived_at: Date | null;
  readonly converted_deal_id: string | null;
  readonly sort_at: Date | null;
}

const sortColumns: Readonly<Record<LeadSortKey, string>> = {
  updated: "lead.updated_at",
  created: "lead.created_at",
  due: "lead.next_action_due_at",
};

interface ResolvedLeadFilter {
  readonly status: LeadStatus | "all" | "open";
  readonly sourceChannel: LeadSourceChannel | null;
  readonly ownerUserId: string | null;
  readonly unassigned: boolean;
  readonly agentProfileVersionId: string | null;
  readonly contactId: string | null;
  readonly query: string;
  readonly since: string | null;
  readonly until: string | null;
  readonly sort: LeadSortKey;
}

/**
 * Validate once, in one place. `listLeads` and `countLeads` both start here so
 * a filter cannot be spelled differently on the two paths.
 */
function resolveFilter(options: LeadListOptions): ResolvedLeadFilter {
  const status = options.status ?? "open";
  if (
    status !== "all" &&
    status !== "open" &&
    !(leadStatuses as readonly string[]).includes(status)
  )
    throw new TypeError("invalid lead status filter");
  const query = (options.query ?? "").trim();
  if (query.length > 200) throw new TypeError("lead search is too long");
  const sort = options.sort ?? "updated";
  if (!(leadSortKeys as readonly string[]).includes(sort))
    throw new TypeError("invalid lead sort");
  for (const [value, label] of [
    [options.since, "lead date filter"],
    [options.until, "lead date filter"],
  ] as const)
    if (value !== undefined && !Number.isFinite(Date.parse(value)))
      throw new TypeError(`${label} must be an instant`);
  return {
    status,
    sourceChannel: options.sourceChannel ?? null,
    ownerUserId: optionalIdentifier(options.ownerUserId, "lead owner"),
    unassigned: options.unassigned === true,
    agentProfileVersionId: optionalIdentifier(
      options.agentProfileVersionId,
      "lead agent version",
    ),
    contactId: optionalIdentifier(options.contactId, "lead contact"),
    query,
    since: options.since ?? null,
    until: options.until ?? null,
    sort,
  };
}

/**
 * The single WHERE fragment behind both the page and its count.
 *
 * `includeStatus` exists only for the status breakdown, which groups BY the
 * status column and therefore cannot also filter on it. Every other predicate
 * is identical in all three queries.
 */
function leadPredicate(
  sql: postgres.Sql | postgres.TransactionSql,
  filter: ResolvedLeadFilter,
  { includeStatus = true }: { readonly includeStatus?: boolean } = {},
): postgres.PendingQuery<never[]> {
  const sortColumn = sql.unsafe(sortColumns[filter.sort]);
  return sql`
    lead.tenant_id = platform.current_tenant_id()
    AND (${!includeStatus}
         OR ${filter.status}::text = 'all'
         OR (${filter.status}::text = 'open'
             AND lead.archived_at IS NULL
             AND lead.status NOT IN ('converted','disqualified','archived'))
         OR lead.status = ${filter.status})
    AND (${filter.sourceChannel}::text IS NULL
         OR lead.source_channel = ${filter.sourceChannel})
    AND (NOT ${filter.unassigned} OR lead.owner_user_id IS NULL)
    AND (${filter.ownerUserId}::uuid IS NULL
         OR lead.owner_user_id = ${filter.ownerUserId}::uuid)
    AND (${filter.agentProfileVersionId}::uuid IS NULL
         OR lead.agent_profile_version_id = ${filter.agentProfileVersionId}::uuid)
    AND (${filter.contactId}::uuid IS NULL
         OR lead.contact_id = ${filter.contactId}::uuid)
    AND (${filter.since}::timestamptz IS NULL
         OR ${sortColumn} >= ${filter.since}::timestamptz)
    AND (${filter.until}::timestamptz IS NULL
         OR ${sortColumn} < ${filter.until}::timestamptz)
    -- A phone number lives on the contact's channel identities, not on the
    -- contact row: the same person may change number and keep one identity.
    AND (${filter.query}::text = ''
         OR lead.reference ILIKE '%' || ${filter.query} || '%'
         OR coalesce(lead.business_objective, '') ILIKE '%' || ${filter.query} || '%'
         OR coalesce(lead.summary, '') ILIKE '%' || ${filter.query} || '%'
         OR coalesce(contact.name, '') ILIKE '%' || ${filter.query} || '%'
         OR EXISTS (
           SELECT 1 FROM crm.contact_channel_identities identity
           WHERE identity.tenant_id = lead.tenant_id
             AND identity.contact_id = lead.contact_id
             AND identity.channel IN ('phone','whatsapp')
             AND identity.normalized_value ILIKE '%' || ${filter.query} || '%'
         ))
  `;
}

/**
 * Completeness for a whole page without a query per lead.
 *
 * Three round trips regardless of page size: the rows, their current field
 * states, and the distinct pinned schemas those rows reference.
 */
async function pageCompleteness(
  sql: postgres.Sql | postgres.TransactionSql,
  rows: readonly LeadListRow[],
): Promise<ReadonlyMap<string, LeadCompleteness>> {
  // Only a lead pinned to a schema has questions to be complete against.
  const withSchema = rows.flatMap((row) =>
    row.field_schema_id === null || row.field_schema_version === null
      ? []
      : [
          {
            id: row.id,
            schemaId: row.field_schema_id,
            schemaVersion: row.field_schema_version,
          },
        ],
  );
  if (withSchema.length === 0) return new Map();
  const leadIds = withSchema.map((row) => row.id);
  const states = await sql<
    { lead_id: string; field_key: string; value_state: LeadFieldState }[]
  >`
    SELECT lead_id, field_key, value_state FROM crm.lead_field_values
    WHERE lead_id = ANY(${leadIds}::uuid[]) AND superseded_at IS NULL
  `;
  const schemaIds = [...new Set(withSchema.map((row) => row.schemaId))];
  const definitions = await sql<
    { id: string; version: number; definition: unknown }[]
  >`
    SELECT id, version, definition FROM crm.lead_field_schemas
    WHERE id = ANY(${schemaIds}::uuid[])
  `;
  const schemas = new Map<string, LeadFieldSchema>();
  for (const row of definitions)
    schemas.set(
      `${row.id}:${String(row.version)}`,
      parseLeadFieldSchema(row.definition),
    );
  const byLead = new Map<string, { key: string; state: LeadFieldState }[]>();
  for (const row of states) {
    const bucket = byLead.get(row.lead_id) ?? [];
    bucket.push({ key: row.field_key, state: row.value_state });
    byLead.set(row.lead_id, bucket);
  }
  const result = new Map<string, LeadCompleteness>();
  for (const row of withSchema) {
    const schema = schemas.get(`${row.schemaId}:${String(row.schemaVersion)}`);
    if (schema === undefined) continue;
    result.set(row.id, leadCompleteness(schema, byLead.get(row.id) ?? []));
  }
  return result;
}

function mapListEntry(
  row: LeadListRow,
  completeness: ReadonlyMap<string, LeadCompleteness>,
): LeadListEntry {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    contactId: row.contact_id,
    contactName: row.contact_name,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    sourceChannel: row.source_channel,
    businessObjective: row.business_objective,
    interestKey: row.interest_key,
    summary: row.summary,
    nextAction: row.next_action,
    nextActionDueAt: row.next_action_due_at?.toISOString() ?? null,
    agentProfileVersionId: row.agent_profile_version_id,
    agentName: row.agent_name,
    agentVersion: row.agent_version,
    fieldSchemaName: row.field_schema_name,
    fieldSchemaVersion: row.field_schema_version,
    completeness: completeness.get(row.id) ?? null,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
    convertedDealId: row.converted_deal_id,
  };
}

/**
 * One page of leads.
 *
 * Keyset rather than OFFSET: an operator working the queue changes it while
 * paging, and OFFSET silently repeats or skips rows when that happens. Sorting
 * by due date puts leads with no due date last on every page rather than
 * letting NULL ordering differ between the page and its cursor.
 */
export async function listLeads(
  sql: postgres.Sql | postgres.TransactionSql,
  options: LeadListOptions = {},
): Promise<LeadPage> {
  const filter = resolveFilter(options);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100);
  const cursorSortAt = options.beforeSortAt ?? null;
  if (cursorSortAt !== null && !Number.isFinite(Date.parse(cursorSortAt)))
    throw new TypeError("invalid lead cursor");
  const cursorId = optionalIdentifier(options.beforeId, "lead cursor");
  const sortColumn = sql.unsafe(sortColumns[filter.sort]);
  const rows = await sql<LeadListRow[]>`
    SELECT lead.id, lead.reference, lead.status, lead.contact_id,
           contact.name AS contact_name, lead.owner_user_id,
           owner.display_name AS owner_name, lead.source_channel,
           lead.business_objective, lead.interest_key, lead.summary,
           lead.next_action, lead.next_action_due_at,
           lead.agent_profile_version_id, profile.name AS agent_name,
           version.version AS agent_version, lead.field_schema_id,
           schema.name AS field_schema_name, lead.field_schema_version,
           lead.revision, lead.created_at, lead.updated_at, lead.archived_at,
           lead.converted_deal_id, ${sortColumn} AS sort_at
    FROM crm.leads lead
    LEFT JOIN crm.contacts contact
      ON contact.tenant_id = lead.tenant_id AND contact.id = lead.contact_id
    LEFT JOIN platform.current_tenant_team() owner
      ON owner.user_id = lead.owner_user_id
    LEFT JOIN agents.agent_profile_versions version
      ON version.tenant_id = lead.tenant_id
      AND version.id = lead.agent_profile_version_id
    LEFT JOIN agents.agent_profiles profile
      ON profile.tenant_id = version.tenant_id
      AND profile.id = version.agent_profile_id
    LEFT JOIN crm.lead_field_schemas schema
      ON schema.tenant_id = lead.tenant_id AND schema.id = lead.field_schema_id
    WHERE ${leadPredicate(sql, filter)}
      AND (${cursorSortAt}::timestamptz IS NULL
           OR (${sortColumn}, lead.id)
              < (${cursorSortAt}::timestamptz, ${cursorId}::uuid))
    ORDER BY ${sortColumn} DESC NULLS LAST, lead.id DESC
    LIMIT ${limit + 1}
  `;
  const completeness = await pageCompleteness(sql, rows.slice(0, limit));
  const page = rows
    .slice(0, limit)
    .map((row) => mapListEntry(row, completeness));
  const last = rows.slice(0, limit).at(-1);
  return {
    leads: page,
    // A row sorted into the NULL tail has no cursor value, so paging stops
    // there rather than restarting the list from the top.
    nextCursor:
      rows.length > limit && last !== undefined && last.sort_at !== null
        ? { sortAt: last.sort_at.toISOString(), id: last.id }
        : null,
  };
}

export interface LeadCounts {
  /** Rows matching EXACTLY the filter `listLeads` would apply. */
  readonly total: number;
  /**
   * The same filter with the status predicate removed, grouped by status —
   * removed because status is the dimension being counted. Every other filter
   * (owner, channel, agent, contact, search, dates) still applies, so a tab
   * badge never counts rows the tab itself would hide.
   */
  readonly byStatus: Readonly<Record<LeadStatus, number>>;
}

export async function countLeads(
  sql: postgres.Sql | postgres.TransactionSql,
  options: LeadListOptions = {},
): Promise<LeadCounts> {
  const filter = resolveFilter(options);
  const totals = await sql<{ total: string }[]>`
    SELECT count(*)::text AS total
    FROM crm.leads lead
    LEFT JOIN crm.contacts contact
      ON contact.tenant_id = lead.tenant_id AND contact.id = lead.contact_id
    WHERE ${leadPredicate(sql, filter)}
  `;
  const grouped = await sql<{ status: LeadStatus; total: string }[]>`
    SELECT lead.status, count(*)::text AS total
    FROM crm.leads lead
    LEFT JOIN crm.contacts contact
      ON contact.tenant_id = lead.tenant_id AND contact.id = lead.contact_id
    WHERE ${leadPredicate(sql, filter, { includeStatus: false })}
    GROUP BY lead.status
  `;
  const byStatus = Object.fromEntries(
    leadStatuses.map((status) => [status, 0]),
  ) as Record<LeadStatus, number>;
  for (const row of grouped) byStatus[row.status] = Number(row.total);
  return { total: Number(totals[0]?.total ?? "0"), byStatus };
}

export interface LeadAgentFilter {
  readonly agentProfileVersionId: string;
  readonly name: string;
  readonly version: number;
}

/**
 * The agents that actually produced leads in this workspace.
 *
 * Deliberately not every published agent: an agent filter offering versions
 * that have never captured anything invites an operator to conclude a filter is
 * broken when it is merely empty.
 */
export async function listLeadAgentFilters(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<readonly LeadAgentFilter[]> {
  const rows = await sql<{ id: string; name: string; version: number }[]>`
    SELECT DISTINCT version.id, profile.name, version.version
    FROM crm.leads lead
    JOIN agents.agent_profile_versions version
      ON version.id = lead.agent_profile_version_id
    JOIN agents.agent_profiles profile ON profile.id = version.agent_profile_id
    WHERE lead.tenant_id = platform.current_tenant_id()
    ORDER BY profile.name, version.version DESC
    LIMIT 100
  `;
  return rows.map((row) => ({
    agentProfileVersionId: row.id,
    name: row.name,
    version: row.version,
  }));
}

export interface LeadDetailField {
  readonly key: string;
  readonly label: string;
  readonly type: LeadFieldType;
  readonly required: boolean;
  readonly description: string | null;
  readonly choices: readonly string[] | null;
  readonly state: LeadFieldState | null;
  readonly rawValue: string | null;
  readonly normalizedValue: string | null;
  readonly currency: string | null;
  readonly confirmation: LeadFieldConfirmation | null;
  readonly observedAt: string | null;
  readonly sourceChannel: string | null;
  readonly sourceReferenceId: string | null;
  readonly recordedBy: LeadRecordedBy | null;
}

export interface LeadFieldHistoryEntry {
  readonly key: string;
  readonly state: LeadFieldState;
  readonly rawValue: string | null;
  readonly normalizedValue: string | null;
  readonly currency: string | null;
  readonly confirmation: LeadFieldConfirmation;
  readonly observedAt: string;
  readonly recordedBy: LeadRecordedBy;
  readonly sourceChannel: string;
  readonly sourceReferenceId: string | null;
  readonly supersededAt: string | null;
}

export interface LeadInteractionLink {
  readonly conversationId: string | null;
  readonly conversationChannel: string | null;
  readonly sessionId: string | null;
  readonly handoffId: string | null;
  readonly sourceMessageId: string | null;
}

export interface LeadCallLink {
  readonly sessionId: string;
  readonly direction: string | null;
  readonly status: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /**
   * `available` only when a stored object actually backs the recording. A URI
   * that resolves to nothing is reported as `missing`, never as playable.
   */
  readonly recording: "available" | "missing";
  readonly transcript: "available" | "missing";
}

export interface LeadAuditEntry {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly occurredAt: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface LeadDetail {
  readonly lead: LeadListEntry;
  readonly contact: {
    readonly id: string;
    readonly name: string | null;
    readonly primaryPhone: string | null;
    readonly email: string | null;
  };
  readonly qualification: Readonly<Record<string, JsonValue>>;
  readonly schema: LeadFieldSchema | null;
  readonly fields: readonly LeadDetailField[];
  readonly history: readonly LeadFieldHistoryEntry[];
  readonly interaction: LeadInteractionLink;
  readonly calls: readonly LeadCallLink[];
  readonly audit: readonly LeadAuditEntry[];
}

interface LeadDetailRow extends LeadListRow {
  readonly qualification: Readonly<Record<string, JsonValue>>;
  readonly source_conversation_id: string | null;
  readonly source_message_id: string | null;
  readonly source_session_id: string | null;
  readonly handoff_id: string | null;
  readonly conversation_channel: string | null;
  readonly contact_email: string | null;
  readonly contact_phone: string | null;
}

/**
 * The full lead: pinned schema, current answers, correction history, the
 * interaction it came from and the operator actions taken on it since.
 *
 * Every list is bounded. A lead worked across many channels accumulates
 * history, and a detail page is not an export surface.
 */
export async function getLeadDetail(
  sql: postgres.Sql | postgres.TransactionSql,
  leadId: string,
  { historyLimit = 200, auditLimit = 100 } = {},
): Promise<LeadDetail | undefined> {
  const id = identifier(leadId, "lead identifier");
  const rows = await sql<LeadDetailRow[]>`
    SELECT lead.id, lead.reference, lead.status, lead.contact_id,
           contact.name AS contact_name, contact.email AS contact_email,
           (SELECT identity.display_value
            FROM crm.contact_channel_identities identity
            WHERE identity.tenant_id = lead.tenant_id
              AND identity.contact_id = lead.contact_id
              AND identity.channel IN ('phone','whatsapp')
            ORDER BY identity.is_primary DESC, identity.created_at
            LIMIT 1) AS contact_phone,
           lead.owner_user_id,
           owner.display_name AS owner_name, lead.source_channel,
           lead.business_objective, lead.interest_key, lead.summary,
           lead.next_action, lead.next_action_due_at,
           lead.agent_profile_version_id, profile.name AS agent_name,
           version.version AS agent_version, lead.field_schema_id,
           schema.name AS field_schema_name, lead.field_schema_version,
           lead.revision, lead.created_at, lead.updated_at, lead.archived_at,
           lead.converted_deal_id, lead.updated_at AS sort_at,
           lead.qualification, lead.source_conversation_id,
           lead.source_message_id, lead.source_session_id, lead.handoff_id,
           channel.kind AS conversation_channel
    FROM crm.leads lead
    LEFT JOIN crm.contacts contact
      ON contact.tenant_id = lead.tenant_id AND contact.id = lead.contact_id
    LEFT JOIN platform.current_tenant_team() owner
      ON owner.user_id = lead.owner_user_id
    LEFT JOIN agents.agent_profile_versions version
      ON version.tenant_id = lead.tenant_id
      AND version.id = lead.agent_profile_version_id
    LEFT JOIN agents.agent_profiles profile
      ON profile.tenant_id = version.tenant_id
      AND profile.id = version.agent_profile_id
    LEFT JOIN crm.lead_field_schemas schema
      ON schema.tenant_id = lead.tenant_id AND schema.id = lead.field_schema_id
    LEFT JOIN messaging.conversations conversation
      ON conversation.tenant_id = lead.tenant_id
      AND conversation.id = lead.source_conversation_id
    LEFT JOIN messaging.channels channel
      ON channel.tenant_id = conversation.tenant_id
      AND channel.id = conversation.channel_id
    WHERE lead.tenant_id = platform.current_tenant_id() AND lead.id = ${id}::uuid
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  const historyRows = await sql<
    {
      field_key: string;
      value_state: LeadFieldState;
      raw_value: string | null;
      normalized_value: string | null;
      value_currency: string | null;
      confirmation_status: LeadFieldConfirmation;
      observed_at: Date;
      recorded_by: LeadRecordedBy;
      source_channel: string;
      source_reference_id: string | null;
      superseded_at: Date | null;
      value_type: LeadFieldType;
    }[]
  >`
    SELECT field_key, value_state, raw_value, normalized_value, value_currency,
           confirmation_status, observed_at, recorded_by, source_channel,
           source_reference_id, superseded_at, value_type
    FROM crm.lead_field_values
    WHERE lead_id = ${id}::uuid
    ORDER BY observed_at DESC, created_at DESC, id DESC
    LIMIT ${Math.min(Math.max(Math.trunc(historyLimit), 1), 500)}
  `;
  const schemaRows =
    row.field_schema_id === null
      ? []
      : await sql<{ definition: unknown }[]>`
          SELECT definition FROM crm.lead_field_schemas
          WHERE id = ${row.field_schema_id}::uuid
        `;
  const schema =
    schemaRows[0] === undefined
      ? null
      : parseLeadFieldSchema(schemaRows[0].definition);
  const current = historyRows.filter((entry) => entry.superseded_at === null);
  const currentByKey = new Map(
    current.map((entry) => [entry.field_key, entry]),
  );
  // Every field the reviewed schema asked for is shown, answered or not:
  // omitting an unanswered field would hide the question from the operator.
  const fields: LeadDetailField[] = (schema?.fields ?? []).map((definition) => {
    const value = currentByKey.get(definition.key);
    return {
      key: definition.key,
      label: definition.label,
      type: definition.type,
      required: definition.required,
      description: definition.description ?? null,
      choices: definition.choices ?? null,
      state: value?.value_state ?? null,
      rawValue: value?.raw_value ?? null,
      normalizedValue: value?.normalized_value ?? null,
      currency: value?.value_currency ?? null,
      confirmation: value?.confirmation_status ?? null,
      observedAt: value?.observed_at.toISOString() ?? null,
      sourceChannel: value?.source_channel ?? null,
      sourceReferenceId: value?.source_reference_id ?? null,
      recordedBy: value?.recorded_by ?? null,
    };
  });
  const known = new Set(fields.map((field) => field.key));
  // A field collected under an earlier schema version is still the customer's
  // answer. It is listed after the current schema rather than discarded.
  for (const entry of current)
    if (!known.has(entry.field_key)) {
      known.add(entry.field_key);
      fields.push({
        key: entry.field_key,
        label: entry.field_key,
        type: entry.value_type,
        required: false,
        description: null,
        choices: null,
        state: entry.value_state,
        rawValue: entry.raw_value,
        normalizedValue: entry.normalized_value,
        currency: entry.value_currency,
        confirmation: entry.confirmation_status,
        observedAt: entry.observed_at.toISOString(),
        sourceChannel: entry.source_channel,
        sourceReferenceId: entry.source_reference_id,
        recordedBy: entry.recorded_by,
      });
    }
  // Every call that worked on this lead: the one that opened it and any
  // callback that continued it, as the lead functions recorded them. A
  // recording is "available" only when an object was actually stored.
  const calls = await sql<
    {
      session_id: string;
      direction: string | null;
      status: string | null;
      started_at: Date | null;
      ended_at: Date | null;
      recording_object_id: string | null;
      transcript_object_id: string | null;
    }[]
  >`
    SELECT session.session_id, session.direction::text, session.status::text,
           session.created_at AS started_at, session.ended_at,
           session.recording_object_id, session.transcript_object_id
    FROM public.sessions session
    WHERE session.tenant_id = platform.current_tenant_id()
      AND (
        session.session_id = ${row.source_session_id}::uuid
        OR session.session_id IN (
          SELECT link.session_id FROM crm.lead_interactions link
          WHERE link.tenant_id = platform.current_tenant_id()
            AND link.lead_id = ${id}::uuid AND link.session_id IS NOT NULL
        )
      )
    ORDER BY session.created_at ASC, session.session_id ASC
  `;
  const auditRows = await sql<
    {
      action: string;
      actor_user_id: string | null;
      actor_name: string | null;
      occurred_at: Date;
      metadata: Readonly<Record<string, JsonValue>> | null;
    }[]
  >`
    SELECT record.action, record.actor_user_id,
           actor.display_name AS actor_name, record.occurred_at, record.metadata
    FROM audit.records record
    LEFT JOIN platform.current_tenant_team() actor
      ON actor.user_id = record.actor_user_id
    WHERE record.tenant_id = platform.current_tenant_id()
      AND record.target_type = 'lead' AND record.target_id = ${id}::uuid
    ORDER BY record.occurred_at DESC, record.id DESC
    LIMIT ${Math.min(Math.max(Math.trunc(auditLimit), 1), 200)}
  `;
  const completeness =
    schema === null
      ? null
      : leadCompleteness(
          schema,
          current.map((entry) => ({
            key: entry.field_key,
            state: entry.value_state,
          })),
        );
  return {
    lead: {
      ...mapListEntry(row, new Map()),
      ...(completeness === null ? {} : { completeness }),
    },
    contact: {
      id: row.contact_id,
      name: row.contact_name,
      primaryPhone: row.contact_phone,
      email: row.contact_email,
    },
    qualification: row.qualification,
    schema,
    fields,
    history: historyRows.map((entry) => ({
      key: entry.field_key,
      state: entry.value_state,
      rawValue: entry.raw_value,
      normalizedValue: entry.normalized_value,
      currency: entry.value_currency,
      confirmation: entry.confirmation_status,
      observedAt: entry.observed_at.toISOString(),
      recordedBy: entry.recorded_by,
      sourceChannel: entry.source_channel,
      sourceReferenceId: entry.source_reference_id,
      supersededAt: entry.superseded_at?.toISOString() ?? null,
    })),
    interaction: {
      conversationId: row.source_conversation_id,
      conversationChannel: row.conversation_channel,
      sessionId: row.source_session_id,
      handoffId: row.handoff_id,
      sourceMessageId: row.source_message_id,
    },
    calls: calls.map((call) => ({
      sessionId: call.session_id,
      direction: call.direction,
      status: call.status,
      startedAt: call.started_at?.toISOString() ?? null,
      endedAt: call.ended_at?.toISOString() ?? null,
      recording: call.recording_object_id === null ? "missing" : "available",
      transcript: call.transcript_object_id === null ? "missing" : "available",
    })),
    audit: auditRows.map((entry) => ({
      action: entry.action,
      actorUserId: entry.actor_user_id,
      actorName: entry.actor_name,
      occurredAt: entry.occurred_at.toISOString(),
      metadata: entry.metadata ?? {},
    })),
  };
}

/**
 * Operator statuses. `converted` is deliberately absent: it is set by the
 * conversion action, which has to create the thing converted TO, not by a
 * dropdown that would otherwise claim a deal exists when none does.
 */
export const operatorLeadStatuses = [
  "new",
  "collecting",
  "ready_for_review",
  "qualified",
  "disqualified",
  "archived",
] as const;
export type OperatorLeadStatus = (typeof operatorLeadStatuses)[number];

export interface LeadOperatorUpdate {
  readonly status?: OperatorLeadStatus;
  /** `null` clears the owner; `undefined` leaves it alone. */
  readonly ownerUserId?: string | null;
  readonly nextAction?: string | null;
  readonly nextActionDueAt?: string | null;
  readonly summary?: string | null;
  readonly expectedRevision?: number;
}

export class LeadWorkspaceConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super("lead was modified by another writer");
    this.name = "LeadWorkspaceConflictError";
    this.currentRevision = currentRevision;
  }
}

function boundedNote(
  value: string | null,
  name: string,
  maximum: number,
): string | null {
  const trimmed = value === null ? "" : value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > maximum)
    throw new TypeError(
      `${name} must be at most ${String(maximum)} characters`,
    );
  return trimmed;
}

/**
 * An operator's own edit to a lead's management fields.
 *
 * Deliberately not a route into `crm.lead_field_values`: this changes who owns
 * the lead and what happens next, never what the customer is recorded as
 * having said. Correcting a collected answer goes through the field path, so
 * the correction keeps a provenance row and the earlier value survives.
 */
export async function updateLeadForOperator(
  sql: postgres.TransactionSql,
  actorUserId: string,
  leadId: string,
  update: LeadOperatorUpdate,
): Promise<LeadListEntry> {
  const id = identifier(leadId, "lead identifier");
  const actor = identifier(actorUserId, "actor identifier");
  if (
    update.status !== undefined &&
    !(operatorLeadStatuses as readonly string[]).includes(update.status)
  )
    throw new TypeError("invalid lead status");
  const owner =
    update.ownerUserId === undefined
      ? undefined
      : optionalIdentifier(update.ownerUserId, "lead owner");
  const nextAction =
    update.nextAction === undefined
      ? undefined
      : boundedNote(update.nextAction, "Next action", 1000);
  const summary =
    update.summary === undefined
      ? undefined
      : boundedNote(update.summary, "Summary", 4000);
  const dueAt =
    update.nextActionDueAt === undefined
      ? undefined
      : boundedNote(update.nextActionDueAt, "Next action due time", 64);
  if (
    dueAt !== undefined &&
    dueAt !== null &&
    !Number.isFinite(Date.parse(dueAt))
  )
    throw new TypeError("Next action due time must be an instant");
  const locked = await sql<
    { revision: number; status: LeadStatus; owner_user_id: string | null }[]
  >`
    SELECT revision, status, owner_user_id FROM crm.leads
    WHERE tenant_id = platform.current_tenant_id() AND id = ${id}::uuid
    FOR UPDATE
  `;
  const before = locked[0];
  if (before === undefined) throw new TypeError("lead not found");
  if (
    update.expectedRevision !== undefined &&
    update.expectedRevision !== before.revision
  )
    throw new LeadWorkspaceConflictError(before.revision);
  const archiving = update.status === "archived";
  const rows = await sql<LeadListRow[]>`
    UPDATE crm.leads lead SET
      status = coalesce(${update.status ?? null}::text, lead.status),
      owner_user_id = CASE WHEN ${owner !== undefined}
        THEN ${owner ?? null}::uuid ELSE lead.owner_user_id END,
      next_action = CASE WHEN ${nextAction !== undefined}
        THEN ${nextAction ?? null}::text ELSE lead.next_action END,
      next_action_due_at = CASE WHEN ${dueAt !== undefined}
        THEN ${dueAt ?? null}::timestamptz ELSE lead.next_action_due_at END,
      summary = CASE WHEN ${summary !== undefined}
        THEN ${summary ?? null}::text ELSE lead.summary END,
      archived_at = CASE WHEN ${archiving} THEN CURRENT_TIMESTAMP
        WHEN ${update.status !== undefined} THEN NULL ELSE lead.archived_at END,
      revision = lead.revision + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE lead.tenant_id = platform.current_tenant_id() AND lead.id = ${id}::uuid
    RETURNING lead.id, lead.reference, lead.status, lead.contact_id,
              NULL::text AS contact_name, lead.owner_user_id,
              NULL::text AS owner_name, lead.source_channel,
              lead.business_objective, lead.interest_key, lead.summary,
              lead.next_action, lead.next_action_due_at,
              lead.agent_profile_version_id, NULL::text AS agent_name,
              NULL::integer AS agent_version, lead.field_schema_id,
              NULL::text AS field_schema_name, lead.field_schema_version,
              lead.revision, lead.created_at, lead.updated_at, lead.archived_at,
              lead.converted_deal_id, lead.updated_at AS sort_at
  `;
  const after = rows[0];
  if (after === undefined) throw new TypeError("lead not found");
  const changed = [
    ...(update.status === undefined ? [] : ["status"]),
    ...(owner === undefined ? [] : ["ownerUserId"]),
    ...(nextAction === undefined ? [] : ["nextAction"]),
    ...(dueAt === undefined ? [] : ["nextActionDueAt"]),
    ...(summary === undefined ? [] : ["summary"]),
  ];
  // Audited with the transition, not the content: who moved the lead and from
  // where is the operational question, and a summary is customer content.
  await sql`
    INSERT INTO audit.records
      (tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (platform.current_tenant_id(), ${actor}::uuid, 'lead.operator_updated',
            'lead', ${id}::uuid,
            ${sql.json(
              databaseJson({
                changed,
                fromStatus: before.status,
                toStatus: after.status,
                revision: after.revision,
              }),
            )})
  `;
  return mapListEntry(after, new Map());
}

/**
 * The write binding for an operator correcting a collected field by hand.
 *
 * The contact is read from the lead row inside the same transaction, never
 * taken from the request: the operator chooses which lead to correct, not which
 * customer the correction is filed against. The capabilities are the two this
 * surface grants — an operator edit is not an agent action and gets no
 * finalize or follow-up authority from here.
 */
export async function operatorLeadBinding(
  sql: postgres.TransactionSql,
  actorUserId: string,
  leadId: string,
): Promise<LeadBinding> {
  const id = identifier(leadId, "lead identifier");
  const rows = await sql<{ contact_id: string }[]>`
    SELECT contact_id FROM crm.leads
    WHERE tenant_id = platform.current_tenant_id() AND id = ${id}::uuid
      AND archived_at IS NULL
  `;
  const row = rows[0];
  if (row === undefined) throw new TypeError("lead not found");
  return {
    contactId: row.contact_id,
    sourceChannel: "manual",
    capabilities: ["lead.read", "lead.write"],
    actorUserId: identifier(actorUserId, "actor identifier"),
    recordedBy: "human",
  };
}
