/**
 * Support tickets: one customer issue, many interactions.
 *
 * The invariant this module exists to hold is that a greeting, a webhook
 * redelivery, a retry and a third call attempt all belong to the SAME issue.
 * Nothing here opens a ticket per event; `openOrAttachTicket` is idempotent on
 * an explicit key and, failing that, attaches to the issue the source
 * conversation is already about.
 *
 * Deliberately separate from two neighbours it is easy to confuse with:
 * `crm.tasks` is internal work (existing escalations own those rows), and
 * `service.cases` is a field-service technician job behind an optional feature.
 * A ticket may LINK a service case; it is never replaced by one.
 */
import type postgres from "postgres";

import type { PostCallAnalysis } from "./post-call-analysis.js";
import type { JsonValue } from "./types.js";

export type TicketStatus = "open" | "closed";
export type TicketStage =
  | "new"
  | "ai_handling"
  | "callback_pending"
  | "in_call"
  | "awaiting_customer"
  | "awaiting_human"
  | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketHandlingMode =
  "ai_whatsapp" | "ai_voice" | "human" | "paused";
export type TicketSourceChannel = "whatsapp" | "voice" | "manual";
export type TicketClosureReason =
  "resolved" | "cancelled" | "duplicate" | "administrative";
export type TicketResolution =
  "unknown" | "unresolved" | "proposed_fix_awaiting_confirmation" | "resolved";
export type TicketConfirmation = "none" | "customer" | "authoritative_evidence";

export type TicketEventKind =
  | "opened"
  | "reopened"
  | "customer_message"
  | "agent_message"
  | "call_attempt"
  | "call_outcome"
  | "recording_state"
  | "summary"
  | "status_change"
  | "assignment"
  | "human_note"
  | "customer_update"
  | "escalation"
  | "action_result";
export type TicketActorKind = "customer" | "ai" | "human" | "system";
export type TicketVisibility = "internal" | "customer_visible";

export interface Ticket {
  readonly id: string;
  readonly reference: string;
  readonly contactId: string;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly stage: TicketStage;
  readonly priority: TicketPriority;
  readonly handlingMode: TicketHandlingMode;
  readonly ownerUserId: string | null;
  readonly sourceChannel: TicketSourceChannel;
  readonly sourceConversationId: string | null;
  readonly serviceCaseId: string | null;
  readonly closureReason: TicketClosureReason | null;
  readonly resolutionClassification: TicketResolution;
  readonly resolutionConfirmedBy: TicketConfirmation;
  readonly nextAction: string | null;
  readonly nextActionDueAt: string | null;
  readonly lastActivityAt: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
}

interface TicketRow {
  id: string;
  reference: string;
  contact_id: string;
  subject: string;
  status: TicketStatus;
  stage: TicketStage;
  priority: TicketPriority;
  handling_mode: TicketHandlingMode;
  owner_user_id: string | null;
  source_channel: TicketSourceChannel;
  source_conversation_id: string | null;
  service_case_id: string | null;
  closure_reason: TicketClosureReason | null;
  resolution_classification: TicketResolution;
  resolution_confirmed_by: TicketConfirmation;
  next_action: string | null;
  next_action_due_at: Date | null;
  last_activity_at: Date;
  opened_at: Date;
  closed_at: Date | null;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > maximum)
    throw new TypeError(
      `${name} must contain between 1 and ${String(maximum)} characters`,
    );
  return normalized;
}

/**
 * An attachment key is how a duplicate webhook, a worker retry and a second
 * concurrent worker all land on one ticket. It is caller-supplied because only
 * the caller knows what "the same admission" means — an inbound message id, a
 * job idempotency key — and it must be stable across those retries.
 */
function attachmentKey(value: string): string {
  if (
    value.length < 8 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  )
    throw new TypeError("ticket attachment key is invalid");
  return value;
}

/** `numeric`/`bigint` columns arrive as strings; anything else is not a number. */
function numeric(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    reference: row.reference,
    contactId: row.contact_id,
    subject: row.subject,
    status: row.status,
    stage: row.stage,
    priority: row.priority,
    handlingMode: row.handling_mode,
    ownerUserId: row.owner_user_id,
    sourceChannel: row.source_channel,
    sourceConversationId: row.source_conversation_id,
    serviceCaseId: row.service_case_id,
    closureReason: row.closure_reason,
    resolutionClassification: row.resolution_classification,
    resolutionConfirmedBy: row.resolution_confirmed_by,
    nextAction: row.next_action,
    nextActionDueAt: row.next_action_due_at?.toISOString() ?? null,
    lastActivityAt: row.last_activity_at.toISOString(),
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}

const TICKET_COLUMNS = `
  ticket.id, ticket.reference, ticket.contact_id, ticket.subject, ticket.status,
  ticket.stage, ticket.priority, ticket.handling_mode, ticket.owner_user_id,
  ticket.source_channel, ticket.source_conversation_id, ticket.service_case_id,
  ticket.closure_reason, ticket.resolution_classification,
  ticket.resolution_confirmed_by, ticket.next_action, ticket.next_action_due_at,
  ticket.last_activity_at, ticket.opened_at, ticket.closed_at
`;

/**
 * Where a phone inquiry's customer follow-up stands. Waiting on the customer
 * and a failed delivery are different situations for staff and never merged.
 */
export type InquiryFollowupAttention =
  | "not_requested"
  | "pending"
  | "awaiting_customer"
  | "customer_replied"
  | "delivery_failed"
  | "blocked";

export interface TicketInquiryState {
  readonly intakeStatus: string;
  readonly followupStatus: string;
  readonly followupMessageStatus: string | null;
  readonly followupRequestedAt: string | null;
  readonly customerRepliedAt: string | null;
  readonly customerMediaReceivedAt: string | null;
  readonly followupError: string | null;
  readonly attention: InquiryFollowupAttention;
}

export interface TicketSummary extends Ticket {
  readonly emergency: {
    readonly at: string;
    readonly reason: string;
    readonly source: "voice" | "manual";
  } | null;
  readonly inquiry: TicketInquiryState | null;
  /** Customer replies that could belong to this inquiry and await linking. */
  readonly pendingReplyLinks: number;
}

interface TicketSummaryRow extends TicketRow {
  emergency_at: Date | null;
  emergency_reason: string | null;
  emergency_source: "voice" | "manual" | null;
  inquiry_state: {
    intakeStatus: string;
    followupStatus: string;
    followupMessageStatus: string | null;
    followupRequestedAt: string | null;
    customerRepliedAt: string | null;
    customerMediaReceivedAt: string | null;
    followupError: string | null;
  } | null;
  pending_reply_links: number;
}

const TICKET_SUMMARY_COLUMNS = `${TICKET_COLUMNS},
  ticket.emergency_at, ticket.emergency_reason, ticket.emergency_source,
  (SELECT jsonb_build_object(
      'intakeStatus', draft.status, 'followupStatus', draft.followup_status,
      'followupMessageStatus', followup.status,
      'followupRequestedAt', draft.followup_requested_at,
      'customerRepliedAt', draft.customer_replied_at,
      'customerMediaReceivedAt', draft.customer_media_received_at,
      'followupError', draft.followup_error_safe)
    FROM service.intake_drafts draft
    LEFT JOIN messaging.messages followup
      ON followup.tenant_id = draft.tenant_id AND followup.id = draft.followup_message_id
    WHERE draft.tenant_id = ticket.tenant_id AND draft.id = ticket.intake_draft_id
  ) AS inquiry_state,
  (SELECT count(*)::integer FROM service.followup_triage triage
    WHERE triage.tenant_id = ticket.tenant_id AND triage.resolved_at IS NULL
      AND ticket.intake_draft_id = ANY(triage.candidate_intake_ids)
  ) AS pending_reply_links
`;

/** Pure: the staff-facing follow-up situation from durable states. */
export function inquiryFollowupAttention(state: {
  readonly followupStatus: string;
  readonly followupMessageStatus: string | null;
  readonly customerRepliedAt: string | null;
}): InquiryFollowupAttention {
  if (state.customerRepliedAt !== null) return "customer_replied";
  if (
    state.followupStatus === "failed" ||
    state.followupMessageStatus === "failed"
  )
    return "delivery_failed";
  if (
    [
      "blocked_consent",
      "blocked_window",
      "no_channel",
      "no_recipient",
      "recipient_conflict",
    ].includes(state.followupStatus)
  )
    return "blocked";
  if (state.followupStatus === "admitted") return "awaiting_customer";
  if (state.followupStatus === "requested" || state.followupStatus === "queued")
    return "pending";
  return "not_requested";
}

function mapTicketSummary(row: TicketSummaryRow): TicketSummary {
  return {
    ...mapTicket(row),
    emergency:
      row.emergency_at === null ||
      row.emergency_reason === null ||
      row.emergency_source === null
        ? null
        : {
            at: row.emergency_at.toISOString(),
            reason: row.emergency_reason,
            source: row.emergency_source,
          },
    inquiry:
      row.inquiry_state === null
        ? null
        : {
            ...row.inquiry_state,
            attention: inquiryFollowupAttention(row.inquiry_state),
          },
    pendingReplyLinks: row.pending_reply_links,
  };
}

export interface OpenTicketInput {
  readonly contactId: string;
  readonly subject: string;
  readonly sourceChannel?: TicketSourceChannel;
  readonly sourceConversationId?: string | null;
  readonly priority?: TicketPriority;
  /** Stable across duplicate deliveries and worker retries. */
  readonly attachmentKey: string;
}

export interface OpenTicketResult {
  readonly ticket: Ticket;
  readonly created: boolean;
}

/**
 * Resolve the issue this interaction belongs to, creating one only if the
 * source conversation has no open issue yet.
 *
 * Association order, and why:
 *  1. The attachment key, recorded as an `opened` timeline event. A redelivered
 *     webhook or a retried job repeats the key and gets the same ticket back
 *     with `created: false`, so no second dial and no second ticket.
 *  2. The open ticket bound to this exact source conversation. This is the
 *     thread the customer is actually replying in.
 *
 * What it deliberately does NOT do is match on phone number and pick the most
 * recent open ticket: a contact may legitimately have several open issues, and
 * guessing between them attaches a call to the wrong one. When the source
 * conversation carries no open issue, a new ticket is the honest answer, and an
 * ambiguous case is resolved by the caller asking rather than by this function
 * guessing.
 */
export async function openOrAttachTicket(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  input: OpenTicketInput,
): Promise<OpenTicketResult> {
  const contactId = identifier(input.contactId, "ticket contact identifier");
  const subject = boundedText(input.subject, "ticket subject", 240);
  const conversationId = optionalIdentifier(
    input.sourceConversationId,
    "ticket source conversation identifier",
  );
  const key = attachmentKey(input.attachmentKey);
  const sourceChannel = input.sourceChannel ?? "whatsapp";
  const priority = input.priority ?? "normal";

  if (conversationId !== null) {
    const openOnThread = await sql<TicketRow[]>`
      SELECT ${sql.unsafe(TICKET_COLUMNS)}
      FROM support.tickets ticket
      WHERE ticket.tenant_id = platform.current_tenant_id()
        AND ticket.source_conversation_id = ${conversationId}::uuid
        AND ticket.contact_id = ${contactId}::uuid
        AND ticket.status = 'open'
      ORDER BY ticket.last_activity_at DESC, ticket.id DESC
      LIMIT 1
      FOR UPDATE
    `;
    if (openOnThread[0] !== undefined)
      return { ticket: mapTicket(openOnThread[0]), created: false };
  }

  // `ON CONFLICT DO NOTHING` on the attachment key, then read the winner back.
  // A read-then-insert would let two concurrent workers both miss and both
  // create a ticket; the unique constraint is the guarantee, and the follow-up
  // SELECT is how the loser of the race learns which ticket it joined.
  const inserted = await sql<TicketRow[]>`
    WITH identifier AS (SELECT gen_random_uuid() AS id)
    INSERT INTO support.tickets AS ticket (
      id, tenant_id, reference, attachment_key, contact_id, subject,
      source_channel, source_conversation_id, priority, stage, handling_mode
    )
    SELECT identifier.id, platform.current_tenant_id(),
      'T-' || to_char(CURRENT_TIMESTAMP, 'YYYY') || '-' ||
        upper(left(replace(identifier.id::text, '-', ''), 8)),
      ${key}, ${contactId}::uuid, ${subject}, ${sourceChannel},
      ${conversationId}::uuid, ${priority}, 'new',
      CASE WHEN ${sourceChannel}::text = 'whatsapp' THEN 'ai_whatsapp' ELSE 'human' END
    FROM identifier
    ON CONFLICT ON CONSTRAINT uq_support_tickets_attachment DO NOTHING
    RETURNING ${sql.unsafe(TICKET_COLUMNS)}
  `;
  const row = inserted[0];
  if (row === undefined) {
    const existing = await sql<TicketRow[]>`
      SELECT ${sql.unsafe(TICKET_COLUMNS)}
      FROM support.tickets ticket
      WHERE ticket.tenant_id = platform.current_tenant_id()
        AND ticket.attachment_key = ${key}
      LIMIT 1
    `;
    const winner = existing[0];
    if (winner === undefined)
      throw new TypeError("support ticket was not created");
    return { ticket: mapTicket(winner), created: false };
  }
  await recordTicketEvent(sql, actorUserId, {
    ticketId: row.id,
    kind: "opened",
    actorKind: actorUserId === null ? "system" : "ai",
    summarySafe: `Issue opened from ${sourceChannel}.`,
    evidence: {
      attachmentKey: key,
      ...(conversationId === null ? {} : { conversationId }),
    },
  });
  return { ticket: mapTicket(row), created: true };
}

export interface TicketEventInput {
  readonly ticketId: string;
  readonly kind: TicketEventKind;
  readonly actorKind: TicketActorKind;
  readonly summarySafe: string;
  readonly visibility?: TicketVisibility;
  /** Typed references only — never message bodies or transcripts. */
  readonly evidence?: Readonly<Record<string, JsonValue>>;
}

/**
 * Append one timeline entry and move the ticket's activity clock.
 *
 * `sequence` is allocated from the ticket's own maximum under the row lock
 * taken here, so two concurrent workers cannot produce the same number; the
 * unique constraint is the backstop rather than the mechanism.
 */
export async function recordTicketEvent(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  input: TicketEventInput,
): Promise<number> {
  const ticketId = identifier(input.ticketId, "ticket identifier");
  const summary = boundedText(input.summarySafe, "ticket event summary", 2000);
  const evidence = input.evidence ?? {};
  // One statement: the UPDATE takes the row lock AND allocates the position.
  // Reading `max(sequence)` in a sibling CTE looked equivalent and was not —
  // CTEs share the statement's snapshot, so two concurrent writers both read
  // the same maximum and the second violated the unique constraint. An
  // `UPDATE ... RETURNING` re-evaluates the row once the lock is granted, so
  // the counter is correct however many workers are appending at once.
  const rows = await sql<{ sequence: number }[]>`
    WITH allocated AS (
      UPDATE support.tickets
      SET next_event_sequence = next_event_sequence + 1,
          last_activity_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = platform.current_tenant_id() AND id = ${ticketId}::uuid
      RETURNING id, next_event_sequence AS sequence
    )
    INSERT INTO support.ticket_events
      (tenant_id, ticket_id, sequence, kind, actor_kind, actor_user_id,
       visibility, summary_safe, evidence)
    SELECT platform.current_tenant_id(), allocated.id, allocated.sequence,
      ${input.kind}, ${input.actorKind}, ${actorUserId}::uuid,
      ${input.visibility ?? "internal"}, ${summary},
      ${sql.json(JSON.parse(JSON.stringify(evidence)) as postgres.JSONValue)}
    FROM allocated
    RETURNING sequence
  `;
  const row = rows[0];
  if (row === undefined) throw new TypeError("support ticket is unavailable");
  return row.sequence;
}

/**
 * Take or release AI ownership of the issue.
 *
 * While `ai_voice` owns a ticket the messaging worker still persists inbound
 * WhatsApp, but must not admit a competing AI reply for it. A human takeover
 * is terminal for automatic work: it is not undone by a later customer
 * message, which mirrors how conversation ownership already behaves.
 */
export async function setTicketHandlingMode(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  ticketId: string,
  mode: TicketHandlingMode,
  reasonSafe: string,
): Promise<Ticket | undefined> {
  const id = identifier(ticketId, "ticket identifier");
  const rows = await sql<TicketRow[]>`
    UPDATE support.tickets AS ticket
    SET handling_mode = ${mode},
        stage = CASE
          WHEN ticket.status = 'closed' THEN ticket.stage
          WHEN ${mode}::text = 'human' THEN 'awaiting_human'
          WHEN ${mode}::text = 'ai_voice' THEN 'in_call'
          ELSE ticket.stage
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE ticket.tenant_id = platform.current_tenant_id()
      AND ticket.id = ${id}::uuid
      -- Human ownership is not handed back to the AI implicitly.
      AND (ticket.handling_mode <> 'human' OR ${mode}::text = 'human')
    RETURNING ${sql.unsafe(TICKET_COLUMNS)}
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  await recordTicketEvent(sql, actorUserId, {
    ticketId: id,
    kind: "assignment",
    actorKind: actorUserId === null ? "system" : "human",
    summarySafe: boundedText(reasonSafe, "handling change reason", 2000),
    evidence: { handlingMode: mode },
  });
  return mapTicket(row);
}

export interface CloseTicketInput {
  readonly ticketId: string;
  readonly closureReason: TicketClosureReason;
  readonly resolutionClassification: TicketResolution;
  readonly resolutionConfirmedBy: TicketConfirmation;
  readonly summarySafe: string;
}

/**
 * Close an issue with an explicit reason.
 *
 * A hangup, a technically completed call, silence or a polite thank-you are
 * none of them evidence. `resolved` therefore requires a confirmation source,
 * which the database also enforces — an administrative closure is a closure,
 * not an AI success, and reports read the two columns together.
 */
export async function closeTicket(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  input: CloseTicketInput,
): Promise<Ticket | undefined> {
  const id = identifier(input.ticketId, "ticket identifier");
  if (
    input.resolutionClassification === "resolved" &&
    input.resolutionConfirmedBy === "none"
  )
    throw new TypeError(
      "a resolved ticket needs customer confirmation or authoritative evidence",
    );
  const rows = await sql<TicketRow[]>`
    UPDATE support.tickets AS ticket
    SET status = 'closed', stage = 'closed',
        closure_reason = ${input.closureReason},
        resolution_classification = ${input.resolutionClassification},
        resolution_confirmed_by = ${input.resolutionConfirmedBy},
        closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE ticket.tenant_id = platform.current_tenant_id()
      AND ticket.id = ${id}::uuid AND ticket.status = 'open'
    RETURNING ${sql.unsafe(TICKET_COLUMNS)}
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  await recordTicketEvent(sql, actorUserId, {
    ticketId: id,
    kind: "status_change",
    actorKind: actorUserId === null ? "system" : "human",
    summarySafe: boundedText(input.summarySafe, "closure summary", 2000),
    evidence: {
      closureReason: input.closureReason,
      resolutionClassification: input.resolutionClassification,
      resolutionConfirmedBy: input.resolutionConfirmedBy,
    },
  });
  return mapTicket(row);
}

/**
 * Reopen the same issue rather than starting a new one.
 *
 * Recurrence of an issue the customer already reported belongs on its original
 * ticket with its earlier evidence intact; a genuinely different problem is a
 * new ticket, which is the caller's decision, not this function's.
 */
export async function reopenTicket(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  ticketId: string,
  reasonSafe: string,
): Promise<Ticket | undefined> {
  const id = identifier(ticketId, "ticket identifier");
  const rows = await sql<TicketRow[]>`
    UPDATE support.tickets AS ticket
    SET status = 'open', stage = 'awaiting_human', closure_reason = NULL,
        closed_at = NULL,
        resolution_classification = 'unresolved',
        resolution_confirmed_by = 'none',
        updated_at = CURRENT_TIMESTAMP
    WHERE ticket.tenant_id = platform.current_tenant_id()
      AND ticket.id = ${id}::uuid AND ticket.status = 'closed'
    RETURNING ${sql.unsafe(TICKET_COLUMNS)}
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  await recordTicketEvent(sql, actorUserId, {
    ticketId: id,
    kind: "reopened",
    actorKind: actorUserId === null ? "system" : "human",
    summarySafe: boundedText(reasonSafe, "reopen reason", 2000),
  });
  return mapTicket(row);
}

export interface TicketTimelineEntry {
  readonly sequence: number;
  readonly kind: TicketEventKind;
  readonly actorKind: TicketActorKind;
  readonly actorUserId: string | null;
  readonly visibility: TicketVisibility;
  readonly summarySafe: string;
  readonly evidence: Readonly<Record<string, JsonValue>>;
  readonly occurredAt: string;
}

export type CallAttemptOutcome =
  | "queued"
  | "dialing"
  | "answered"
  | "no_answer"
  | "busy"
  | "voicemail"
  | "refused"
  | "cancelled"
  | "disconnected"
  | "provider_timeout"
  | "failed";
export type RecordingState =
  "pending" | "processing" | "ready" | "partial" | "failed" | "unavailable";
/**
 * `not_applicable` is the honest state for a busy signal: there was no
 * conversation, so no summary is owed and none is missing.
 */
export type SummaryState =
  "pending" | "processing" | "ready" | "failed" | "not_applicable";
export type AssuranceLevel =
  "none" | "channel_associated" | "callback_confirmed" | "verified";

/**
 * The durable post-call workflow's position for one attempt.
 *
 * Column state rather than worker state on purpose: a restarted worker, a
 * redelivered job and a concurrent retry all read the position from here, and
 * every transition is conditioned on finding the stage it expects.
 */
export type PostCallStage =
  | "not_started"
  | "artifacts_pending"
  | "artifacts_verified"
  | "summary_pending"
  | "summary_ready"
  | "ticket_updated"
  | "followup_pending"
  | "complete";

/** Independent of the recording: either artifact can arrive without the other. */
export type TranscriptState =
  "pending" | "valid" | "partial" | "empty" | "missing" | "failed";

export type FollowupState =
  | "not_required"
  | "pending"
  | "sent"
  | "blocked_window"
  | "blocked_consent"
  | "failed";

export interface TicketCallAttempt {
  readonly id: string;
  readonly attemptNumber: number;
  readonly sessionId: string | null;
  readonly outcome: CallAttemptOutcome;
  readonly assuranceLevel: AssuranceLevel;
  readonly recordingState: RecordingState;
  readonly recordingObjectId: string | null;
  readonly transcriptObjectId: string | null;
  readonly summaryState: SummaryState;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** Where the durable post-call workflow currently stands for this attempt. */
  readonly postCallStage: PostCallStage;
  readonly postCallErrorSafe: string | null;
  /** A fixed verification code, not prose: `header_only`, `bytes_unavailable`… */
  readonly recordingDetail: string | null;
  readonly recordingDurationSeconds: number | null;
  readonly recordingByteSize: number | null;
  readonly transcriptState: TranscriptState;
  readonly transcriptDetail: string | null;
  readonly transcriptTurnCount: number | null;
  readonly analysis: PostCallAnalysis | null;
  readonly analysisModel: string | null;
  readonly followupState: FollowupState;
  readonly followupSentAt: string | null;
}

export interface TicketDetail {
  readonly ticket: TicketSummary;
  readonly timeline: readonly TicketTimelineEntry[];
  readonly attempts: readonly TicketCallAttempt[];
}

/**
 * The full issue: the ticket, its ordered timeline and every call attempt.
 *
 * The timeline is bounded because a long-running issue can accumulate hundreds
 * of entries and the detail page is not an export surface.
 */
export async function getTicketDetail(
  sql: postgres.TransactionSql,
  ticketId: string,
  timelineLimit = 200,
): Promise<TicketDetail | undefined> {
  const id = identifier(ticketId, "ticket identifier");
  const rows = await sql<TicketSummaryRow[]>`
    SELECT ${sql.unsafe(TICKET_SUMMARY_COLUMNS)}
    FROM support.tickets ticket
    WHERE ticket.tenant_id = platform.current_tenant_id() AND ticket.id = ${id}::uuid
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  const limit = Math.min(Math.max(Math.trunc(timelineLimit), 1), 500);
  const events = await sql<
    {
      sequence: number;
      kind: TicketEventKind;
      actor_kind: TicketActorKind;
      actor_user_id: string | null;
      visibility: TicketVisibility;
      summary_safe: string;
      evidence: Readonly<Record<string, JsonValue>>;
      occurred_at: Date;
    }[]
  >`
    SELECT sequence, kind, actor_kind, actor_user_id, visibility,
           summary_safe, evidence, occurred_at
    FROM support.ticket_events
    WHERE tenant_id = platform.current_tenant_id() AND ticket_id = ${id}::uuid
    ORDER BY sequence DESC
    LIMIT ${limit}
  `;
  const attempts = await sql<
    {
      id: string;
      attempt_number: number;
      session_id: string | null;
      outcome: CallAttemptOutcome;
      assurance_level: AssuranceLevel;
      recording_state: RecordingState;
      recording_object_id: string | null;
      transcript_object_id: string | null;
      summary_state: SummaryState;
      queued_at: Date;
      started_at: Date | null;
      ended_at: Date | null;
      post_call_stage: PostCallStage;
      post_call_error_safe: string | null;
      recording_detail_safe: string | null;
      recording_duration_seconds: string | number | null;
      recording_byte_size: string | number | null;
      transcript_state: TranscriptState;
      transcript_detail_safe: string | null;
      transcript_turn_count: number | null;
      analysis: unknown;
      analysis_model_safe: string | null;
      followup_state: FollowupState;
      followup_sent_at: Date | null;
    }[]
  >`
    SELECT id, attempt_number, session_id, outcome, assurance_level,
           recording_state, recording_object_id, transcript_object_id,
           summary_state, queued_at, started_at, ended_at, post_call_stage,
           post_call_error_safe, recording_detail_safe,
           recording_duration_seconds, recording_byte_size, transcript_state,
           transcript_detail_safe, transcript_turn_count, analysis,
           analysis_model_safe, followup_state, followup_sent_at
    FROM support.ticket_call_attempts
    WHERE tenant_id = platform.current_tenant_id() AND ticket_id = ${id}::uuid
    ORDER BY attempt_number DESC
  `;
  return {
    ticket: mapTicketSummary(row),
    timeline: events.map((event) => ({
      sequence: event.sequence,
      kind: event.kind,
      actorKind: event.actor_kind,
      actorUserId: event.actor_user_id,
      visibility: event.visibility,
      summarySafe: event.summary_safe,
      evidence: event.evidence,
      occurredAt: event.occurred_at.toISOString(),
    })),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attempt_number,
      sessionId: attempt.session_id,
      outcome: attempt.outcome,
      assuranceLevel: attempt.assurance_level,
      recordingState: attempt.recording_state,
      recordingObjectId: attempt.recording_object_id,
      transcriptObjectId: attempt.transcript_object_id,
      summaryState: attempt.summary_state,
      queuedAt: attempt.queued_at.toISOString(),
      startedAt: attempt.started_at?.toISOString() ?? null,
      endedAt: attempt.ended_at?.toISOString() ?? null,
      postCallStage: attempt.post_call_stage,
      postCallErrorSafe: attempt.post_call_error_safe,
      recordingDetail: attempt.recording_detail_safe,
      // `numeric` and `bigint` arrive as strings from the driver; a silent NaN
      // in a duration would render as a blank cell rather than an error.
      recordingDurationSeconds: numeric(attempt.recording_duration_seconds),
      recordingByteSize: numeric(attempt.recording_byte_size),
      transcriptState: attempt.transcript_state,
      transcriptDetail: attempt.transcript_detail_safe,
      transcriptTurnCount: attempt.transcript_turn_count,
      analysis:
        attempt.analysis === null ||
        typeof attempt.analysis !== "object" ||
        Array.isArray(attempt.analysis)
          ? null
          : (attempt.analysis as PostCallAnalysis),
      analysisModel: attempt.analysis_model_safe,
      followupState: attempt.followup_state,
      followupSentAt: attempt.followup_sent_at?.toISOString() ?? null,
    })),
  };
}

export interface TicketListOptions {
  readonly status?: TicketStatus | "all";
  readonly stage?: TicketStage;
  readonly priority?: TicketPriority;
  readonly sourceChannel?: TicketSourceChannel;
  readonly handlingMode?: TicketHandlingMode;
  /** Filter on the evidence-backed outcome, not on a model's opinion of it. */
  readonly resolution?: TicketResolution;
  /** Only open emergencies (red calls). */
  readonly emergencyOnly?: boolean;
  readonly query?: string;
  readonly ownerUserId?: string;
  /** Inclusive lower bound on `lastActivityAt`. */
  readonly activeSince?: string;
  readonly limit?: number;
  /** Keyset cursor: the previous page's last `lastActivityAt` and `id`. */
  readonly beforeActivityAt?: string;
  readonly beforeId?: string;
}

export interface TicketPage {
  readonly tickets: readonly TicketSummary[];
  readonly nextCursor: {
    readonly activityAt: string;
    readonly id: string;
  } | null;
}

/**
 * One page of tickets, newest activity first.
 *
 * Keyset rather than OFFSET: an operator working a queue changes it while
 * paging, and OFFSET silently skips or repeats rows when that happens. The
 * page size is capped here so a large tenant cannot be asked to ship its whole
 * history to a browser.
 */
export async function listTickets(
  sql: postgres.TransactionSql,
  options: TicketListOptions = {},
): Promise<TicketPage> {
  const status = options.status ?? "open";
  const query = (options.query ?? "").trim();
  if (query.length > 200) throw new TypeError("ticket search is too long");
  const ownerUserId = optionalIdentifier(options.ownerUserId, "ticket owner");
  const stage = options.stage ?? null;
  const priority = options.priority ?? null;
  const sourceChannel = options.sourceChannel ?? null;
  const handlingMode = options.handlingMode ?? null;
  const resolution = options.resolution ?? null;
  const emergencyOnly = options.emergencyOnly === true;
  const activeSince = options.activeSince ?? null;
  if (activeSince !== null && !Number.isFinite(Date.parse(activeSince)))
    throw new TypeError("ticket activity filter must be an instant");
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100);
  const cursorActivity = options.beforeActivityAt ?? null;
  const cursorId = optionalIdentifier(options.beforeId, "ticket cursor");
  const rows = await sql<TicketSummaryRow[]>`
    SELECT ${sql.unsafe(TICKET_SUMMARY_COLUMNS)}
    FROM support.tickets ticket
    LEFT JOIN crm.contacts contact
      ON contact.tenant_id = ticket.tenant_id AND contact.id = ticket.contact_id
    WHERE ticket.tenant_id = platform.current_tenant_id()
      AND (${status}::text = 'all' OR ticket.status = ${status})
      AND (${stage}::text IS NULL OR ticket.stage = ${stage})
      AND (${priority}::text IS NULL OR ticket.priority = ${priority})
      AND (${sourceChannel}::text IS NULL OR ticket.source_channel = ${sourceChannel})
      AND (${handlingMode}::text IS NULL OR ticket.handling_mode = ${handlingMode})
      AND (${resolution}::text IS NULL
           OR ticket.resolution_classification = ${resolution})
      AND (NOT ${emergencyOnly}::boolean OR ticket.emergency_at IS NOT NULL)
      AND (${activeSince}::timestamptz IS NULL
           OR ticket.last_activity_at >= ${activeSince}::timestamptz)
      AND (${ownerUserId}::uuid IS NULL OR ticket.owner_user_id = ${ownerUserId}::uuid)
      -- A phone number is a LOOKUP attribute on the contact's channel
      -- identities, not a column on the contact: the same person may change
      -- number, and the immutable contact id stays the identity.
      AND (${query}::text = ''
           OR ticket.reference ILIKE '%' || ${query} || '%'
           OR ticket.subject ILIKE '%' || ${query} || '%'
           OR coalesce(contact.name, '') ILIKE '%' || ${query} || '%'
           OR EXISTS (
             SELECT 1 FROM crm.contact_channel_identities identity
             WHERE identity.tenant_id = ticket.tenant_id
               AND identity.contact_id = ticket.contact_id
               AND identity.channel IN ('phone','whatsapp')
               AND identity.normalized_value ILIKE '%' || ${query} || '%'
           ))
      AND (${cursorActivity}::timestamptz IS NULL
           OR (ticket.last_activity_at, ticket.id)
              < (${cursorActivity}::timestamptz, ${cursorId}::uuid))
    ORDER BY ticket.last_activity_at DESC, ticket.id DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit).map(mapTicketSummary);
  const last = page.at(-1);
  return {
    tickets: page,
    nextCursor:
      rows.length > limit && last !== undefined
        ? { activityAt: last.lastActivityAt, id: last.id }
        : null,
  };
}
