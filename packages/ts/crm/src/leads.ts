/**
 * Durable lead capture, TypeScript side.
 *
 * Every write goes through a server-bound {@link LeadBinding}: the tenant, the
 * contact, the interaction and the authorising operator are resolved before the
 * model is ever consulted, so a tool call can only ever name *which field* it
 * observed, never *whose* record to touch.
 *
 * This module normalizes against the canonical contract and then commits
 * through the `platform.lead_*` PostgreSQL functions — the same functions the
 * Python voice runtime calls. Those functions own binding checks, capability
 * rechecks against the pinned agent version, worker fencing, idempotency on a
 * caller-supplied operation key, revision checks, human-verified precedence and
 * the durable receipt. Runtime roles hold no direct write grant on lead rows, so
 * there is no second write path to drift from the first.
 *
 * Operation keys are derived from durable facts (interaction plus turn), not
 * from a freshly generated tool-call ID, so a retry after a worker restart
 * recognises its own committed write instead of duplicating it. The agent may
 * only claim "saved" once it holds the receipt a write returns.
 */

import type postgres from "postgres";

import {
  assertCapability,
  type AgentCapability,
} from "./agent-capabilities.js";
import { leadCaptureContract } from "./lead-capture-contract.generated.js";
import {
  leadCompleteness,
  leadFieldSchemaJson,
  normalizeLeadField,
  parseLeadFieldSchema,
  type LeadCompleteness,
  type LeadFieldConfirmation,
  type LeadFieldObservationInput,
  type LeadFieldSchema,
  type LeadFieldState,
  type LeadFieldType,
  type LeadNormalizationOptions,
} from "./lead-schema.js";

export const leadStatuses = leadCaptureContract.enums.leadStatuses;
export type LeadStatus = (typeof leadStatuses)[number];

export const leadSourceChannels = leadCaptureContract.enums.sourceChannels;
export type LeadSourceChannel = (typeof leadSourceChannels)[number];

export type LeadRecordedBy = "agent" | "human" | "system";

export type LeadOperationName =
  (typeof leadCaptureContract.enums.operations)[number];

/**
 * Server-resolved identity for a lead write. Nothing here is model-supplied:
 * the caller derives it from the authenticated interaction before dispatch.
 */
export interface LeadBinding {
  readonly contactId: string;
  readonly sourceChannel: LeadSourceChannel;
  readonly capabilities: readonly AgentCapability[];
  /** The operator who authorised this agent to act, never the model. */
  readonly actorUserId?: string;
  readonly recordedBy: LeadRecordedBy;
  readonly agentProfileVersionId?: string;
  /**
   * WhatsApp: the live conversation. Voice: the conversation that requested
   * the call, which is how the call finds the lead that conversation started.
   */
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly handoffId?: string;
  /**
   * Fences a superseded worker: a write from a conversation generation that has
   * since been handed to a human, or re-owned, is rejected rather than applied.
   */
  readonly conversationOwnershipEpoch?: string;
  readonly normalization?: LeadNormalizationOptions;
}

export interface LeadFieldStateRow {
  readonly key: string;
  readonly type: LeadFieldType;
  readonly state: LeadFieldState;
  readonly rawValue: string | null;
  readonly normalizedValue: string | null;
  readonly currency: string | null;
  readonly confirmation: LeadFieldConfirmation;
  readonly observedAt: string;
  readonly sourceChannel: LeadSourceChannel | "import";
  readonly sourceReferenceId: string | null;
  readonly recordedBy: LeadRecordedBy;
  readonly supersededAt: string | null;
}

export interface LeadSnapshot {
  readonly id: string;
  readonly reference: string;
  readonly contactId: string;
  readonly status: LeadStatus;
  readonly revision: number;
  readonly businessObjective: string | null;
  readonly interestKey: string | null;
  readonly summary: string | null;
  readonly nextAction: string | null;
  readonly nextActionDueAt: string | null;
  readonly ownerUserId: string | null;
  readonly sourceChannel: LeadSourceChannel;
  readonly agentProfileVersionId: string | null;
  readonly fieldSchemaId: string | null;
  readonly fieldSchemaVersion: number | null;
  readonly fields: readonly LeadFieldStateRow[];
  readonly completeness: LeadCompleteness | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LeadReceipt {
  readonly leadId: string;
  readonly reference: string;
  readonly operation: LeadOperationName;
  readonly operationKey: string;
  readonly revision: number;
  readonly status: "committed" | "replayed";
  readonly changed: readonly string[];
  readonly committedAt: string;
}

export interface LeadRejection {
  readonly key: string;
  readonly code?: string;
  readonly reason: string;
}

export class LeadRevisionConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super("lead was modified by another writer");
    this.name = "LeadRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

export class LeadOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadOwnershipError";
  }
}

export class LeadNotFoundError extends Error {
  constructor() {
    super("lead is not available for this tenant and interaction");
    this.name = "LeadNotFoundError";
  }
}

/** The database refused the write for this binding: a truthful "not allowed". */
export class LeadAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadAuthorizationError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

function requireUuid(value: string, label: string): string {
  if (!uuidPattern.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value;
}

function requireOperationKey(value: string): string {
  const key = value.trim();
  if (
    key.length < leadCaptureContract.limits.operationKeyMin ||
    key.length > leadCaptureContract.limits.operationKeyMax
  )
    throw new TypeError("operation key must contain 8–200 characters");
  return key;
}

/** Blank optional text is absent, not an empty string, in the record. */
function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

function databaseJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

/** The binding as the `platform.lead_*` functions read it. Capabilities are
 * not sent: the database rechecks the pinned agent version itself. */
function bindingJson(binding: LeadBinding): postgres.JSONValue {
  return databaseJson({
    contactId: binding.contactId,
    sourceChannel: binding.sourceChannel,
    recordedBy: binding.recordedBy,
    ...(binding.actorUserId === undefined
      ? {}
      : { actorUserId: binding.actorUserId }),
    ...(binding.agentProfileVersionId === undefined
      ? {}
      : { agentProfileVersionId: binding.agentProfileVersionId }),
    ...(binding.conversationId === undefined
      ? {}
      : { conversationId: binding.conversationId }),
    ...(binding.sessionId === undefined
      ? {}
      : { sessionId: binding.sessionId }),
    ...(binding.handoffId === undefined
      ? {}
      : { handoffId: binding.handoffId }),
    ...(binding.conversationOwnershipEpoch === undefined
      ? {}
      : { conversationOwnershipEpoch: binding.conversationOwnershipEpoch }),
  });
}

interface DatabaseError {
  readonly code?: string;
  readonly detail?: string;
  readonly message: string;
}

/**
 * Translate the lead functions' SQLSTATEs into the errors callers already
 * handle. Anything else — a dropped connection, a timeout — propagates as is:
 * an unknown commit result must be reconciled with {@link readLeadOperation},
 * never reported as a rejection.
 */
function leadError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { code, detail, message } = error as Error & DatabaseError;
  switch (code) {
    case "LD409":
      return new LeadRevisionConflictError(Number(detail));
    case "LD404":
      return new LeadNotFoundError();
    case "LD410":
    case "LD423":
      return new LeadOwnershipError(message);
    case "LD403":
      return new LeadAuthorizationError(message);
    case "LD412":
    case "LD422":
      return new TypeError(message);
    default:
      return error;
  }
}

async function leadCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw leadError(error);
  }
}

/** Lets a caller with an unknown commit result reconcile before rewriting. */
export async function readLeadOperation(
  sql: postgres.Sql | postgres.TransactionSql,
  binding: LeadBinding,
  operationKey: string,
): Promise<LeadReceipt | null> {
  const rows = await leadCall(
    () => sql<{ receipt: LeadReceipt | null }[]>`
      SELECT platform.lead_operation_receipt(
        ${sql.json(bindingJson(binding))}, ${requireOperationKey(operationKey)}
      ) AS receipt
    `,
  );
  return rows[0]?.receipt ?? null;
}

async function loadSchema(
  sql: postgres.Sql | postgres.TransactionSql,
  schemaId: string | null,
  schemaVersion: number | null,
): Promise<LeadFieldSchema | null> {
  if (schemaId === null || schemaVersion === null) return null;
  const rows = await sql<{ definition: unknown }[]>`
    SELECT definition FROM crm.lead_field_schemas
    WHERE id=${schemaId}::uuid AND version=${schemaVersion}
  `;
  const row = rows[0];
  return row === undefined ? null : parseLeadFieldSchema(row.definition);
}

interface LeadRow {
  readonly id: string;
  readonly reference: string;
  readonly contact_id: string;
  readonly status: LeadStatus;
  readonly revision: number;
  readonly business_objective: string | null;
  readonly interest_key: string | null;
  readonly summary: string | null;
  readonly next_action: string | null;
  readonly next_action_due_at: Date | null;
  readonly owner_user_id: string | null;
  readonly source_channel: LeadSourceChannel;
  readonly agent_profile_version_id: string | null;
  readonly field_schema_id: string | null;
  readonly field_schema_version: number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const leadColumns = `id, reference, contact_id, status, revision, business_objective,
  interest_key, summary, next_action, next_action_due_at, owner_user_id,
  source_channel, agent_profile_version_id, field_schema_id, field_schema_version,
  created_at, updated_at`;

async function readFields(
  sql: postgres.Sql | postgres.TransactionSql,
  leadId: string,
  { history = false }: { readonly history?: boolean } = {},
): Promise<readonly LeadFieldStateRow[]> {
  const rows = await sql<
    {
      field_key: string;
      value_type: LeadFieldType;
      value_state: LeadFieldState;
      raw_value: string | null;
      normalized_value: string | null;
      value_currency: string | null;
      confirmation_status: LeadFieldConfirmation;
      observed_at: Date;
      source_channel: LeadSourceChannel | "import";
      source_reference_id: string | null;
      recorded_by: LeadRecordedBy;
      superseded_at: Date | null;
    }[]
  >`
    SELECT field_key, value_type, value_state, raw_value, normalized_value,
           value_currency, confirmation_status, observed_at, source_channel,
           source_reference_id, recorded_by, superseded_at
    FROM crm.lead_field_values
    WHERE lead_id=${leadId}::uuid
      AND (${history} OR superseded_at IS NULL)
    ORDER BY field_key ASC, created_at DESC, id DESC
  `;
  return rows.map((row) => ({
    key: row.field_key,
    type: row.value_type,
    state: row.value_state,
    rawValue: row.raw_value,
    normalizedValue: row.normalized_value,
    currency: row.value_currency,
    confirmation: row.confirmation_status,
    observedAt: row.observed_at.toISOString(),
    sourceChannel: row.source_channel,
    sourceReferenceId: row.source_reference_id,
    recordedBy: row.recorded_by,
    supersededAt: row.superseded_at?.toISOString() ?? null,
  }));
}

async function snapshot(
  sql: postgres.Sql | postgres.TransactionSql,
  row: LeadRow,
  options: { readonly history?: boolean } = {},
): Promise<LeadSnapshot> {
  const fields = await readFields(sql, row.id, options);
  const schema = await loadSchema(
    sql,
    row.field_schema_id,
    row.field_schema_version,
  );
  const current = fields.filter((field) => field.supersededAt === null);
  return {
    id: row.id,
    reference: row.reference,
    contactId: row.contact_id,
    status: row.status,
    revision: row.revision,
    businessObjective: row.business_objective,
    interestKey: row.interest_key,
    summary: row.summary,
    nextAction: row.next_action,
    nextActionDueAt: row.next_action_due_at?.toISOString() ?? null,
    ownerUserId: row.owner_user_id,
    sourceChannel: row.source_channel,
    agentProfileVersionId: row.agent_profile_version_id,
    fieldSchemaId: row.field_schema_id,
    fieldSchemaVersion: row.field_schema_version,
    fields,
    completeness: schema === null ? null : leadCompleteness(schema, current),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Read a lead this binding may see: same tenant (RLS) and same contact. */
async function boundLeadRow(
  sql: postgres.Sql | postgres.TransactionSql,
  binding: Pick<LeadBinding, "contactId">,
  leadId: string,
): Promise<LeadRow> {
  const rows = await sql<LeadRow[]>`
    SELECT ${sql.unsafe(leadColumns)} FROM crm.leads
    WHERE id=${requireUuid(leadId, "leadId")}::uuid AND archived_at IS NULL
  `;
  const row = rows[0];
  // The interaction's own contact is authoritative. A lead belonging to someone
  // else is invisible to this conversation even inside the same tenant.
  if (row?.contact_id !== binding.contactId) throw new LeadNotFoundError();
  return row;
}

export interface LeadFieldSchemaRecord {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly description: string | null;
  readonly schema: LeadFieldSchema;
  readonly publishedAt: string | null;
}

/**
 * Store a reviewed field schema. Publishing freezes it: a later revision is a
 * new version row, so a lead pinned to version 1 keeps asking version 1's
 * questions even after the operator edits the agent.
 */
export async function createLeadFieldSchema(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: {
    readonly name: string;
    readonly definition: unknown;
    readonly description?: string;
    readonly publish?: boolean;
  },
): Promise<LeadFieldSchemaRecord> {
  const name = input.name.trim();
  if (!name || name.length > 120)
    throw new TypeError("a schema name of 1–120 characters is required");
  const schema = parseLeadFieldSchema(input.definition);
  const existing = await sql<{ version: number }[]>`
    SELECT version FROM crm.lead_field_schemas
    WHERE lower(name)=lower(${name}) ORDER BY version DESC LIMIT 1
  `;
  const version = (existing[0]?.version ?? 0) + 1;
  const rows = await sql<
    {
      id: string;
      name: string;
      version: number;
      description: string | null;
      published_at: Date | null;
    }[]
  >`
    INSERT INTO crm.lead_field_schemas
      (tenant_id, name, version, description, definition, published_at,
       created_by_user_id)
    VALUES (platform.current_tenant_id(), ${name}, ${version},
            ${trimmedOrNull(input.description)},
            ${sql.json(databaseJson(leadFieldSchemaJson(schema)))},
            ${input.publish === false ? null : sql`CURRENT_TIMESTAMP`},
            ${actorUserId}::uuid)
    RETURNING id, name, version, description, published_at
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("lead field schema insert failed");
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    schema,
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

/** Published field schemas an operator can pin an agent to, newest first. */
export async function listLeadFieldSchemas(
  sql: postgres.Sql | postgres.TransactionSql,
): Promise<readonly LeadFieldSchemaRecord[]> {
  const rows = await sql<
    {
      id: string;
      name: string;
      version: number;
      description: string | null;
      definition: unknown;
      published_at: Date | null;
    }[]
  >`
    SELECT id, name, version, description, definition, published_at
    FROM crm.lead_field_schemas
    WHERE published_at IS NOT NULL
    ORDER BY lower(name) ASC, version DESC
    LIMIT 200
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    schema: parseLeadFieldSchema(row.definition),
    publishedAt: row.published_at?.toISOString() ?? null,
  }));
}

export interface EnsureLeadInput {
  readonly operationKey: string;
  readonly businessObjective?: string;
  /**
   * Distinguishes genuinely different commercial interests for one person. Two
   * interests stay two leads; a redelivered webhook for one interest does not.
   */
  readonly interestKey?: string;
  readonly fieldSchemaId?: string;
  readonly fieldSchemaVersion?: number;
  readonly sourceMessageId?: string;
}

export interface EnsureLeadResult {
  readonly lead: LeadSnapshot;
  readonly receipt: LeadReceipt;
  readonly created: boolean;
}

/**
 * Open the lead this interaction collects into, or continue the one it is
 * already linked to — including a lead the originating WhatsApp conversation
 * started, when this is the callback it asked for.
 */
export async function ensureLeadForInteraction(
  sql: postgres.TransactionSql,
  binding: LeadBinding,
  input: EnsureLeadInput,
): Promise<EnsureLeadResult> {
  assertCapability(binding.capabilities, "lead.write");
  requireUuid(binding.contactId, "contactId");
  if (
    input.fieldSchemaId !== undefined &&
    input.fieldSchemaVersion === undefined
  )
    throw new TypeError("a pinned field schema requires its version");
  const rows = await leadCall(
    () => sql<{ result: { receipt: LeadReceipt; created: boolean } }[]>`
      SELECT platform.lead_ensure_for_interaction(
        ${sql.json(bindingJson(binding))},
        ${requireOperationKey(input.operationKey)},
        ${input.fieldSchemaId ?? null}::uuid,
        ${input.fieldSchemaVersion ?? null}::integer,
        ${input.businessObjective ?? null},
        ${input.interestKey ?? null},
        ${input.sourceMessageId ?? null}::uuid
      ) AS result
    `,
  );
  const result = rows[0]?.result;
  if (result === undefined) throw new Error("lead ensure returned no result");
  return {
    lead: await snapshot(
      sql,
      await boundLeadRow(sql, binding, result.receipt.leadId),
    ),
    receipt: result.receipt,
    created: result.created,
  };
}

export async function readLeadState(
  sql: postgres.Sql | postgres.TransactionSql,
  binding: Pick<LeadBinding, "contactId" | "capabilities">,
  leadId: string,
  options: { readonly history?: boolean } = {},
): Promise<LeadSnapshot> {
  assertCapability(binding.capabilities, "lead.read");
  return snapshot(sql, await boundLeadRow(sql, binding, leadId), options);
}

/**
 * The lead this interaction is already working on, if there is one.
 *
 * Resolved by the database from what the interaction is linked to — itself,
 * the conversation that requested a call, or its handoff — and scoped to the
 * bound contact, so an agent cannot reach another person's lead by naming it
 * and a call never adopts "the customer's latest lead" by phone number.
 * Returns null before the first save: a greeting has not created a lead.
 */
export async function findInteractionLead(
  sql: postgres.Sql | postgres.TransactionSql,
  binding: LeadBinding,
  options: { readonly interestKey?: string } = {},
): Promise<LeadSnapshot | null> {
  assertCapability(binding.capabilities, "lead.read");
  requireUuid(binding.contactId, "contactId");
  const rows = await leadCall(
    () => sql<{ state: { lead: { id: string } } | null }[]>`
      SELECT platform.lead_capture_state(
        ${sql.json(bindingJson(binding))}, NULL, ${options.interestKey ?? null}
      ) AS state
    `,
  );
  const leadId = rows[0]?.state?.lead.id;
  return leadId === undefined
    ? null
    : snapshot(sql, await boundLeadRow(sql, binding, leadId));
}

export interface SaveLeadFieldsInput {
  readonly leadId: string;
  readonly operationKey: string;
  readonly observations: readonly LeadFieldObservationInput[];
  readonly expectedRevision?: number;
}

export interface SaveLeadFieldsResult {
  readonly receipt: LeadReceipt;
  readonly lead: LeadSnapshot;
  readonly rejected: readonly LeadRejection[];
}

export async function saveLeadFields(
  sql: postgres.TransactionSql,
  binding: LeadBinding,
  input: SaveLeadFieldsInput,
): Promise<SaveLeadFieldsResult> {
  assertCapability(binding.capabilities, "lead.write");
  const operationKey = requireOperationKey(input.operationKey);
  const leadId = requireUuid(input.leadId, "leadId");
  if (input.observations.length === 0)
    throw new TypeError("at least one observation is required");
  if (
    input.observations.length > leadCaptureContract.limits.observationsPerCall
  )
    throw new TypeError("at most 40 observations may be saved at once");
  const row = await boundLeadRow(sql, binding, leadId);
  const schema = await loadSchema(
    sql,
    row.field_schema_id,
    row.field_schema_version,
  );
  if (schema === null)
    throw new TypeError("this lead has no reviewed field schema to save into");
  // Normalized here against the contract; bound, checked and committed by the
  // database function both runtimes share.
  const observations = input.observations.map((observation) =>
    normalizeLeadField(schema, observation, binding.normalization ?? {}),
  );
  const entry =
    binding.recordedBy === "human"
      ? sql`platform.lead_operator_save_fields`
      : sql`platform.lead_save_fields`;
  const rows = await leadCall(
    () => sql<
      { result: { receipt: LeadReceipt; rejected: readonly LeadRejection[] } }[]
    >`
      SELECT ${entry}(
        ${sql.json(bindingJson(binding))}, ${leadId}::uuid, ${operationKey},
        ${input.expectedRevision ?? null}::integer,
        ${sql.json(databaseJson(observations))}
      ) AS result
    `,
  );
  const result = rows[0]?.result;
  if (result === undefined) throw new Error("lead save returned no result");
  return {
    receipt: result.receipt,
    lead: await snapshot(sql, await boundLeadRow(sql, binding, leadId)),
    rejected: result.rejected,
  };
}

export interface FinalizeLeadInput {
  readonly leadId: string;
  readonly operationKey: string;
  readonly summary: string;
  readonly nextAction?: string;
  readonly expectedRevision?: number;
}

export async function finalizeLeadCollection(
  sql: postgres.TransactionSql,
  binding: LeadBinding,
  input: FinalizeLeadInput,
): Promise<{ readonly receipt: LeadReceipt; readonly lead: LeadSnapshot }> {
  assertCapability(binding.capabilities, "lead.finalize");
  const leadId = requireUuid(input.leadId, "leadId");
  const summary = input.summary.trim();
  if (!summary || summary.length > leadCaptureContract.limits.summaryLength)
    throw new TypeError(
      "a finalization summary of 1–4000 characters is required",
    );
  const rows = await leadCall(
    () => sql<{ result: { receipt: LeadReceipt } }[]>`
      SELECT platform.lead_finalize(
        ${sql.json(bindingJson(binding))}, ${leadId}::uuid,
        ${requireOperationKey(input.operationKey)},
        ${input.expectedRevision ?? null}::integer, ${summary},
        ${trimmedOrNull(input.nextAction)}
      ) AS result
    `,
  );
  const result = rows[0]?.result;
  if (result === undefined) throw new Error("lead finalize returned no result");
  return {
    receipt: result.receipt,
    lead: await snapshot(sql, await boundLeadRow(sql, binding, leadId)),
  };
}

export interface LeadFollowUpInput {
  readonly leadId: string;
  readonly operationKey: string;
  readonly note: string;
  readonly dueAt?: string;
}

export async function requestLeadFollowUp(
  sql: postgres.TransactionSql,
  binding: LeadBinding,
  input: LeadFollowUpInput,
): Promise<{ readonly receipt: LeadReceipt; readonly lead: LeadSnapshot }> {
  assertCapability(binding.capabilities, "lead.follow_up");
  const leadId = requireUuid(input.leadId, "leadId");
  const note = input.note.trim();
  if (!note || note.length > leadCaptureContract.limits.followUpNoteLength)
    throw new TypeError("a follow-up note of 1–1000 characters is required");
  if (input.dueAt !== undefined && Number.isNaN(Date.parse(input.dueAt)))
    throw new TypeError("follow-up due time must be an ISO timestamp");
  const rows = await leadCall(
    () => sql<{ result: { receipt: LeadReceipt } }[]>`
      SELECT platform.lead_request_follow_up(
        ${sql.json(bindingJson(binding))}, ${leadId}::uuid,
        ${requireOperationKey(input.operationKey)}, ${note},
        ${input.dueAt ?? null}::timestamptz
      ) AS result
    `,
  );
  const result = rows[0]?.result;
  if (result === undefined)
    throw new Error("lead follow-up returned no result");
  return {
    receipt: result.receipt,
    lead: await snapshot(sql, await boundLeadRow(sql, binding, leadId)),
  };
}
