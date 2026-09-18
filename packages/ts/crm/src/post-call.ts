/**
 * The durable post-call pipeline: one terminal call, one workflow, one result.
 *
 * Nothing here runs during a call. The voice runtime owes its final session
 * write and its artifacts; a trigger on that write enqueues the job this module
 * serves, and everything expensive — reading a recording out of object storage,
 * asking a model what happened, sending WhatsApp — happens afterwards where it
 * can fail, retry and be looked at.
 *
 * Every transition is an UPDATE conditioned on the stage it expects to find, so
 * a redelivered job, a restarted worker and a concurrent retry all converge:
 * whichever one arrives second finds the stage already moved and does nothing.
 * That is the whole idempotency story, and it is deliberately in the database
 * rather than in a lock the worker holds.
 *
 * The verification and analysis results are written as facts with sources. What
 * they are NOT allowed to do is decide a resolution on their own — that lives in
 * `post-call-analysis.ts` as pure rules, and the database rejects a resolved
 * ticket with no confirmation regardless of what either of them concluded.
 */
import type postgres from "postgres";

import {
  decideTicketResolution,
  type AnalysisSource,
  type PostCallAnalysis,
  type ResolutionDecision,
} from "./post-call-analysis.js";
import { recordTicketEvent, setTicketHandlingMode } from "./tickets.js";
import type { WhatsAppChannelConfiguration } from "./whatsapp-outbound.js";
import type {
  AssuranceLevel,
  CallAttemptOutcome,
  FollowupState,
  PostCallStage,
  RecordingState,
  SummaryState,
  TicketPriority,
  TranscriptState,
} from "./tickets.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function identifier(value: string, name: string): string {
  if (!uuidPattern.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function bounded(value: string, name: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > maximum)
    throw new TypeError(
      `${name} must contain 1 to ${String(maximum)} characters`,
    );
  return normalized;
}

function databaseJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export interface OpenCallAttemptInput {
  readonly ticketId: string;
  /** The `whatsapp.ai.call` job: one admission, one attempt, however many retries. */
  readonly jobId: string;
  readonly handoffId?: string | null;
  readonly destinationIdentityId?: string | null;
  readonly assuranceLevel?: AssuranceLevel;
}

export interface TicketCallAttemptRecord {
  readonly id: string;
  readonly attemptNumber: number;
  readonly created: boolean;
}

/**
 * Record that a dial was admitted for this issue.
 *
 * Created BEFORE the provider is called, so an accepted dial whose response is
 * lost still has a row to reconcile against instead of becoming a second call.
 * The attempt number comes from a counter on the ticket for the same reason the
 * timeline sequence does.
 */
export async function openTicketCallAttempt(
  sql: postgres.TransactionSql,
  input: OpenCallAttemptInput,
): Promise<TicketCallAttemptRecord> {
  const ticketId = identifier(input.ticketId, "ticket identifier");
  const jobId = identifier(input.jobId, "call job identifier");
  const inserted = await sql<{ id: string; attempt_number: number }[]>`
    WITH allocated AS (
      UPDATE support.tickets
      SET next_attempt_number = next_attempt_number + 1,
          last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = platform.current_tenant_id() AND id = ${ticketId}::uuid
      RETURNING id, next_attempt_number AS attempt_number
    )
    INSERT INTO support.ticket_call_attempts
      (tenant_id, ticket_id, attempt_number, job_id, handoff_id,
       destination_identity_id, assurance_level, outcome)
    SELECT platform.current_tenant_id(), allocated.id, allocated.attempt_number,
           ${jobId}::uuid, ${input.handoffId ?? null}::uuid,
           ${input.destinationIdentityId ?? null}::uuid,
           ${input.assuranceLevel ?? "channel_associated"}, 'queued'
    FROM allocated
    ON CONFLICT DO NOTHING
    RETURNING id, attempt_number
  `;
  const row = inserted[0];
  if (row !== undefined)
    return { id: row.id, attemptNumber: row.attempt_number, created: true };
  const existing = await sql<{ id: string; attempt_number: number }[]>`
    SELECT id, attempt_number FROM support.ticket_call_attempts
    WHERE tenant_id = platform.current_tenant_id() AND job_id = ${jobId}::uuid
    LIMIT 1
  `;
  const winner = existing[0];
  if (winner === undefined)
    throw new TypeError("support call attempt was not recorded");
  return {
    id: winner.id,
    attemptNumber: winner.attempt_number,
    created: false,
  };
}

/**
 * Bind the accepted dial's canonical session to its attempt.
 *
 * The unique index on `(tenant_id, session_id)` is what stops a replayed
 * acceptance attaching the same call to two attempts. The `enqueue_post_call`
 * call afterwards covers the ordering the trigger cannot: a call short enough to
 * be terminal before its acceptance was even recorded here.
 */
export async function bindTicketCallAttemptSession(
  sql: postgres.TransactionSql,
  attemptId: string,
  sessionId: string,
): Promise<boolean> {
  const attempt = identifier(attemptId, "call attempt identifier");
  const session = identifier(sessionId, "voice session identifier");
  const rows = await sql<{ id: string }[]>`
    UPDATE support.ticket_call_attempts
    SET session_id = ${session}::uuid, outcome = 'dialing',
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${attempt}::uuid
      AND (session_id IS NULL OR session_id = ${session}::uuid)
    RETURNING id
  `;
  if (rows[0] === undefined) return false;
  await sql`
    SELECT support.enqueue_post_call(platform.current_tenant_id(), ${session}::uuid)
    WHERE EXISTS (
      SELECT 1 FROM public.sessions
      WHERE session_id = ${session}::uuid
        AND tenant_id = platform.current_tenant_id()
        AND status IN ('ended','failed')
    )
  `;
  return true;
}

export interface PostCallWork {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly ticketId: string;
  readonly ticketReference: string;
  readonly ticketSubject: string;
  readonly ticketStatus: "open" | "closed";
  readonly ticketPriority: TicketPriority;
  readonly contactId: string;
  readonly conversationId: string | null;
  readonly sessionId: string | null;
  readonly handoffId: string | null;
  readonly stage: PostCallStage;
  readonly postCallAttempts: number;
  readonly callOutcome: CallAttemptOutcome;
  readonly sessionStatus: string | null;
  readonly sessionAnswered: boolean | null;
  readonly sessionOutcome: string | null;
  readonly recordingState: RecordingState;
  readonly transcriptState: TranscriptState;
  readonly transcriptTurnCount: number;
  readonly summaryState: SummaryState;
  readonly followupState: FollowupState;
  readonly analysis: PostCallAnalysis | null;
}

interface PostCallWorkRow {
  attempt_id: string;
  attempt_number: number;
  ticket_id: string;
  reference: string;
  subject: string;
  ticket_status: "open" | "closed";
  priority: TicketPriority;
  contact_id: string;
  conversation_id: string | null;
  session_id: string | null;
  handoff_id: string | null;
  post_call_stage: PostCallStage;
  post_call_attempts: number;
  outcome: CallAttemptOutcome;
  session_status: string | null;
  session_answered: boolean | null;
  session_outcome: string | null;
  recording_state: RecordingState;
  transcript_state: TranscriptState;
  transcript_turn_count: number | null;
  summary_state: SummaryState;
  followup_state: FollowupState;
  analysis: unknown;
}

/**
 * Everything one pipeline run needs, in one tenant-scoped read.
 *
 * `public.sessions` is joined rather than trusted from the payload: the worker
 * must classify the call from the canonical row, not from whatever the job was
 * created with, because the two can differ by the time a retry runs.
 */
export async function loadPostCallWork(
  sql: postgres.TransactionSql,
  attemptId: string,
): Promise<PostCallWork | undefined> {
  const id = identifier(attemptId, "call attempt identifier");
  const rows = await sql<PostCallWorkRow[]>`
    SELECT attempt.id AS attempt_id, attempt.attempt_number, attempt.ticket_id,
           ticket.reference, ticket.subject, ticket.status AS ticket_status,
           ticket.priority, ticket.contact_id, ticket.source_conversation_id AS conversation_id,
           attempt.session_id, attempt.handoff_id, attempt.post_call_stage,
           attempt.post_call_attempts, attempt.outcome,
           session.status::text AS session_status, session.answered AS session_answered,
           session.outcome AS session_outcome, attempt.recording_state,
           attempt.transcript_state, attempt.transcript_turn_count,
           attempt.summary_state, attempt.followup_state, attempt.analysis
    FROM support.ticket_call_attempts attempt
    JOIN support.tickets ticket
      ON ticket.tenant_id = attempt.tenant_id AND ticket.id = attempt.ticket_id
    LEFT JOIN public.sessions session
      ON session.tenant_id = attempt.tenant_id AND session.session_id = attempt.session_id
    WHERE attempt.tenant_id = platform.current_tenant_id()
      AND attempt.id = ${id}::uuid
    FOR UPDATE OF attempt
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    attemptId: row.attempt_id,
    attemptNumber: row.attempt_number,
    ticketId: row.ticket_id,
    ticketReference: row.reference,
    ticketSubject: row.subject,
    ticketStatus: row.ticket_status,
    ticketPriority: row.priority,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    handoffId: row.handoff_id,
    stage: row.post_call_stage,
    postCallAttempts: row.post_call_attempts,
    callOutcome: row.outcome,
    sessionStatus: row.session_status,
    sessionAnswered: row.session_answered,
    sessionOutcome: row.session_outcome,
    recordingState: row.recording_state,
    transcriptState: row.transcript_state,
    transcriptTurnCount: row.transcript_turn_count ?? 0,
    summaryState: row.summary_state,
    followupState: row.followup_state,
    analysis:
      row.analysis === null || typeof row.analysis !== "object"
        ? null
        : (row.analysis as PostCallAnalysis),
  };
}

/**
 * The dialled outcome, derived from the canonical session rather than guessed.
 *
 * Busy, no answer, voicemail and a provider timeout are distinct and none of
 * them is a conversation. A session that ended without ever being answered is
 * `no_answer`, not `disconnected` — the difference decides whether a summary is
 * owed at all.
 */
export function callOutcomeFromSession(
  status: string | null,
  answered: boolean | null,
  outcome: string | null,
): CallAttemptOutcome {
  const detail = (outcome ?? "").toLowerCase();
  if (status === null) return "failed";
  if (detail.includes("busy")) return "busy";
  if (detail.includes("voicemail")) return "voicemail";
  if (detail.includes("timeout")) return "provider_timeout";
  if (detail.includes("cancel")) return "cancelled";
  if (detail.includes("refus") || detail.includes("declin")) return "refused";
  if (detail.includes("no_answer") || detail.includes("noanswer"))
    return "no_answer";
  if (status === "failed") return answered === true ? "disconnected" : "failed";
  if (answered === true) return "answered";
  return "no_answer";
}

export interface VerifiedArtifact {
  readonly state: "ready" | "partial" | "unavailable" | "failed";
  readonly detail: string;
  readonly byteSize: number | null;
  readonly durationSeconds: number | null;
  readonly contentType: string | null;
  readonly checksum: string | null;
  readonly storageBackend: "local" | "gcs" | null;
  readonly storageKey: string | null;
}

export interface VerifiedTranscript {
  readonly state: TranscriptState;
  readonly detail: string;
  readonly byteSize: number | null;
  readonly turnCount: number;
  readonly contentType: string | null;
  readonly checksum: string | null;
  readonly storageBackend: "local" | "gcs" | null;
  readonly storageKey: string | null;
}

/**
 * Register a verified artifact in the object registry and return its id.
 *
 * This is what makes `recording_state = ready` honest rather than a promise:
 * the schema already refuses a ready recording without an object row, and the
 * only code that can create that row is this one, after the bytes were read,
 * sized and checksummed. An unverified artifact simply never gets an id.
 */
async function registerVerifiedObject(
  sql: postgres.TransactionSql,
  sessionId: string,
  category: "recording" | "transcript",
  artifact: {
    readonly byteSize: number | null;
    readonly checksum: string | null;
    readonly contentType: string | null;
    readonly storageBackend: "local" | "gcs" | null;
    readonly storageKey: string | null;
  },
): Promise<string | null> {
  if (
    artifact.byteSize === null ||
    artifact.checksum === null ||
    artifact.contentType === null ||
    artifact.storageBackend === null ||
    artifact.storageKey === null
  )
    return null;
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO objects.object_metadata
      (tenant_id, owner_type, owner_id, category, content_type, byte_size,
       checksum, storage_backend, storage_key, status)
    VALUES (platform.current_tenant_id(), 'voice_session', ${sessionId}::uuid,
            ${category}, ${artifact.contentType}, ${artifact.byteSize},
            ${artifact.checksum}, ${artifact.storageBackend},
            ${artifact.storageKey}, 'available')
    ON CONFLICT (storage_backend, storage_key) DO UPDATE
      SET byte_size = EXCLUDED.byte_size, checksum = EXCLUDED.checksum,
          content_type = EXCLUDED.content_type, status = 'available',
          updated_at = CURRENT_TIMESTAMP
    WHERE object_metadata.tenant_id = platform.current_tenant_id()
      AND object_metadata.owner_id = ${sessionId}::uuid
    RETURNING id
  `;
  const row = inserted[0];
  if (row !== undefined) return row.id;
  // A conflicting key owned by a different tenant or session is not ours to
  // claim. Returning null keeps the attempt out of `ready` rather than pointing
  // it at somebody else's object.
  return null;
}

export interface ArtifactVerificationOutcome {
  readonly recordingState: RecordingState;
  readonly transcriptState: TranscriptState;
  readonly analysable: boolean;
}

/**
 * Persist what verification found and move the workflow on.
 *
 * Both artifacts are recorded independently because they arrive independently:
 * a transcript can be complete while the recording upload is still in flight,
 * and a call that died leaves audio with nothing said in it. The stage advances
 * either way — a missing recording is a fact about the call, not a reason to
 * stop processing it.
 */
export async function recordArtifactVerification(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  input: {
    readonly attemptId: string;
    readonly ticketId: string;
    readonly sessionId: string;
    readonly callOutcome: CallAttemptOutcome;
    readonly recording: VerifiedArtifact;
    readonly transcript: VerifiedTranscript;
  },
): Promise<ArtifactVerificationOutcome> {
  const attemptId = identifier(input.attemptId, "call attempt identifier");
  const sessionId = identifier(input.sessionId, "voice session identifier");
  const playable =
    input.recording.state === "ready" || input.recording.state === "partial";
  const readable =
    input.transcript.state === "valid" || input.transcript.state === "partial";
  const recordingObjectId = playable
    ? await registerVerifiedObject(sql, sessionId, "recording", input.recording)
    : null;
  const transcriptObjectId = readable
    ? await registerVerifiedObject(
        sql,
        sessionId,
        "transcript",
        input.transcript,
      )
    : null;
  // An object the registry would not give us is an unverified artifact, and the
  // honest state for one of those is `unavailable`, not `ready`.
  const recordingState: RecordingState =
    playable && recordingObjectId === null
      ? "unavailable"
      : input.recording.state;
  const analysable = readable && input.callOutcome === "answered";
  const rows = await sql<{ id: string }[]>`
    UPDATE support.ticket_call_attempts
    SET recording_state = ${recordingState},
        recording_object_id = COALESCE(${recordingObjectId}::uuid, recording_object_id),
        recording_detail_safe = ${input.recording.detail},
        recording_byte_size = ${input.recording.byteSize},
        recording_duration_seconds = ${input.recording.durationSeconds},
        transcript_state = ${input.transcript.state},
        transcript_object_id = COALESCE(${transcriptObjectId}::uuid, transcript_object_id),
        transcript_detail_safe = ${input.transcript.detail},
        transcript_turn_count = ${input.transcript.turnCount},
        outcome = ${input.callOutcome},
        ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
        artifacts_verified_at = CURRENT_TIMESTAMP,
        summary_state = ${analysable ? "pending" : "not_applicable"},
        post_call_stage = 'artifacts_verified',
        post_call_error_safe = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${attemptId}::uuid
      AND post_call_stage IN ('artifacts_pending','artifacts_verified')
    RETURNING id
  `;
  if (rows[0] === undefined)
    return {
      recordingState: input.recording.state,
      transcriptState: input.transcript.state,
      analysable: false,
    };
  await recordTicketEvent(sql, actorUserId, {
    ticketId: input.ticketId,
    kind: "recording_state",
    actorKind: "system",
    summarySafe: `Call artifacts verified: recording ${recordingState}, transcript ${input.transcript.state}.`,
    evidence: {
      sessionId,
      callOutcome: input.callOutcome,
      recording: {
        state: recordingState,
        detail: input.recording.detail,
        durationSeconds: input.recording.durationSeconds,
        byteSize: input.recording.byteSize,
      },
      transcript: {
        state: input.transcript.state,
        detail: input.transcript.detail,
        turnCount: input.transcript.turnCount,
      },
    },
  });
  return {
    recordingState,
    transcriptState: input.transcript.state,
    analysable,
  };
}

/** Mark the analysis in flight so a crash is visible rather than silent. */
export async function beginPostCallAnalysis(
  sql: postgres.TransactionSql,
  attemptId: string,
): Promise<boolean> {
  const id = identifier(attemptId, "call attempt identifier");
  const rows = await sql<{ id: string }[]>`
    UPDATE support.ticket_call_attempts
    SET post_call_stage = 'summary_pending', summary_state = 'processing',
        post_call_attempts = post_call_attempts + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${id}::uuid
      AND post_call_stage IN ('artifacts_verified','summary_pending')
    RETURNING id
  `;
  return rows[0] !== undefined;
}

/**
 * Move past the analysis when there was no conversation to analyse.
 *
 * A busy signal owes no summary. Parking the attempt at `artifacts_verified`
 * would leave it looking like work still pending forever, and marking it
 * `failed` would claim something broke; the attempt keeps
 * `summary_state = not_applicable` and the workflow continues.
 */
export async function skipPostCallAnalysis(
  sql: postgres.TransactionSql,
  attemptId: string,
): Promise<boolean> {
  const id = identifier(attemptId, "call attempt identifier");
  const rows = await sql<{ id: string }[]>`
    UPDATE support.ticket_call_attempts
    SET post_call_stage = 'summary_ready', updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${id}::uuid
      AND post_call_stage = 'artifacts_verified'
    RETURNING id
  `;
  return rows[0] !== undefined;
}

/**
 * Store the validated analysis verbatim.
 *
 * Verbatim matters: an operator may later correct what the ticket displays, and
 * the original model output has to survive that so the correction is auditable
 * against what was actually produced.
 */
export async function recordPostCallAnalysis(
  sql: postgres.TransactionSql,
  input: {
    readonly attemptId: string;
    readonly analysis: PostCallAnalysis;
    readonly modelSafe: string;
  },
): Promise<boolean> {
  const id = identifier(input.attemptId, "call attempt identifier");
  const rows = await sql<{ id: string }[]>`
    UPDATE support.ticket_call_attempts
    SET analysis = ${sql.json(databaseJson(input.analysis))},
        analysis_schema_version = ${input.analysis.schemaVersion},
        analysis_model_safe = ${bounded(input.modelSafe, "analysis model", 120)},
        analysis_completed_at = CURRENT_TIMESTAMP,
        summary_state = 'ready', post_call_stage = 'summary_ready',
        post_call_error_safe = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${id}::uuid
      AND post_call_stage IN ('summary_pending','summary_ready')
    RETURNING id
  `;
  return rows[0] !== undefined;
}

/**
 * Record that the analysis could not be produced, without inventing one.
 *
 * The ticket, the artifacts and the call all survive; only the summary is
 * missing, and it says so. `permanent` distinguishes a provider that will
 * never succeed for this input from one that was briefly unavailable.
 */
export async function failPostCallAnalysis(
  sql: postgres.TransactionSql,
  input: {
    readonly attemptId: string;
    readonly errorSafe: string;
    readonly permanent: boolean;
  },
): Promise<void> {
  const id = identifier(input.attemptId, "call attempt identifier");
  await sql`
    UPDATE support.ticket_call_attempts
    SET summary_state = ${input.permanent ? "failed" : "pending"},
        post_call_stage = ${input.permanent ? "summary_ready" : "artifacts_verified"},
        post_call_error_safe = ${bounded(input.errorSafe, "analysis error", 200)},
        updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${id}::uuid
      AND post_call_stage IN ('summary_pending','artifacts_verified')
  `;
}

export interface TicketOutcomeUpdate {
  readonly decision: ResolutionDecision;
  readonly followupRequired: boolean;
}

/**
 * Apply the deterministic outcome to the SAME ticket the issue has always had.
 *
 * No ticket is created here and none is closed here. A resolution the customer
 * confirmed on the call is recorded and left open, because the wrap-up message
 * is about to give them the chance to say otherwise, and a system that closes
 * before asking has decided the answer in advance.
 */
export async function applyPostCallOutcome(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  input: {
    readonly attemptId: string;
    readonly ticketId: string;
    readonly analysis: PostCallAnalysis | null;
    readonly callOutcome: CallAttemptOutcome;
    readonly transcriptState: TranscriptState;
    readonly sessionId: string | null;
  },
): Promise<TicketOutcomeUpdate> {
  const attemptId = identifier(input.attemptId, "call attempt identifier");
  const ticketId = identifier(input.ticketId, "ticket identifier");
  const decision = decideTicketResolution({
    analysis: input.analysis ?? undefined,
    callOutcome: input.callOutcome,
    transcriptState: input.transcriptState,
  });
  const advanced = await sql<{ id: string }[]>`
    UPDATE support.ticket_call_attempts
    SET post_call_stage = 'ticket_updated', updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${attemptId}::uuid
      AND post_call_stage IN ('summary_ready','ticket_updated')
    RETURNING id
  `;
  if (advanced[0] === undefined) return { decision, followupRequired: false };

  // A closed ticket is not reopened by a late pipeline run: an operator who
  // closed it during processing made a decision, and overwriting it with a
  // model's reading of a call they already saw is exactly the wrong outcome.
  const updated = await sql<{ id: string }[]>`
    UPDATE support.tickets
    SET resolution_classification = ${decision.resolution},
        resolution_confirmed_by = ${decision.confirmedBy},
        stage = ${decision.stage},
        next_action = ${input.analysis?.nextAction ?? null},
        last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${ticketId}::uuid
      AND status = 'open'
    RETURNING id
  `;
  if (updated[0] === undefined) return { decision, followupRequired: false };

  await recordTicketEvent(sql, actorUserId, {
    ticketId,
    kind: "summary",
    actorKind: "ai",
    summarySafe:
      input.analysis === null
        ? "No call summary is available for this attempt."
        : input.analysis.issue,
    evidence:
      input.analysis === null
        ? { sessionId: input.sessionId, summaryState: "unavailable" }
        : {
            sessionId: input.sessionId,
            schemaVersion: input.analysis.schemaVersion,
            // References, not prose: the timeline links to evidence and the
            // analysis column holds the text it was drawn from.
            actionsAttempted: input.analysis.actionsAttempted.length,
            actionsCompleted: input.analysis.actionsCompleted.map(
              (action) => action.receipt.reference,
            ),
            commitments: input.analysis.commitments.length,
            classificationConfidence: input.analysis.classificationConfidence,
            classificationSources: input.analysis.classificationSources.map(
              (source: AnalysisSource) => `${source.kind}:${source.reference}`,
            ),
          },
  });
  await recordTicketEvent(sql, actorUserId, {
    ticketId,
    kind: "status_change",
    actorKind: "system",
    summarySafe: `Post-call outcome recorded: ${decision.resolution}.`,
    evidence: {
      reason: decision.reason,
      resolution: decision.resolution,
      confirmedBy: decision.confirmedBy,
      callOutcome: input.callOutcome,
    },
  });
  if (decision.requiresHuman)
    await setTicketHandlingMode(
      sql,
      actorUserId,
      ticketId,
      "human",
      "The call ended needing a person.",
    );
  return { decision, followupRequired: decision.askCustomer };
}

/**
 * Hand the wrap-up message to its own durable job.
 *
 * Separate on purpose: WhatsApp can be down, a template can be unapproved and a
 * customer can opt out between the call and the message. None of that is
 * allowed to undo a correctly summarised call, so the summary commits here and
 * the send retries on its own budget.
 */
export async function schedulePostCallFollowup(
  sql: postgres.TransactionSql,
  input: {
    readonly attemptId: string;
    readonly required: boolean;
  },
): Promise<boolean> {
  const id = identifier(input.attemptId, "call attempt identifier");
  if (!input.required) {
    await sql`
      UPDATE support.ticket_call_attempts
      SET followup_state = 'not_required', post_call_stage = 'complete',
          updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = platform.current_tenant_id() AND id = ${id}::uuid
        AND post_call_stage = 'ticket_updated'
    `;
    return false;
  }
  const rows = await sql<{ id: string }[]>`
    UPDATE support.ticket_call_attempts
    SET followup_state = 'pending', post_call_stage = 'followup_pending',
        updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${id}::uuid
      AND post_call_stage IN ('ticket_updated','followup_pending')
    RETURNING id
  `;
  if (rows[0] === undefined) return false;
  await sql`
    INSERT INTO ops.jobs
      (tenant_id, queue, job_type, reference_type, reference_id, payload,
       idempotency_key, max_attempts, priority)
    VALUES (platform.current_tenant_id(), 'messaging', 'support.postcall.followup',
            'ticket_call_attempt', ${id}::uuid,
            jsonb_build_object('attemptId', ${id}::uuid),
            ${`support-followup:${id}`}, 5, 15)
    ON CONFLICT DO NOTHING
  `;
  return true;
}

/** Record the wrap-up outcome; only a delivered message may claim `sent`. */
export async function recordFollowupOutcome(
  sql: postgres.TransactionSql,
  input: {
    readonly attemptId: string;
    readonly state: FollowupState;
    readonly messageId?: string | null;
    readonly errorSafe?: string;
  },
): Promise<void> {
  const id = identifier(input.attemptId, "call attempt identifier");
  const messageId =
    input.state === "sent"
      ? identifier(input.messageId ?? "", "follow-up message identifier")
      : null;
  await sql`
    UPDATE support.ticket_call_attempts
    SET followup_state = ${input.state},
        followup_message_id = COALESCE(${messageId}::uuid, followup_message_id),
        followup_sent_at = CASE WHEN ${input.state}::text = 'sent'
          THEN CURRENT_TIMESTAMP ELSE followup_sent_at END,
        post_call_error_safe = ${input.errorSafe ?? null},
        -- Only a pending follow-up still owes work; every other state is a
        -- final answer about this attempt, including the blocked ones.
        post_call_stage = CASE WHEN ${input.state}::text = 'pending'
          THEN 'followup_pending' ELSE 'complete' END,
        updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${id}::uuid
      AND post_call_stage IN ('followup_pending','complete')
  `;
}

export interface FollowupPlan {
  readonly attemptId: string;
  readonly ticketId: string;
  readonly ticketReference: string;
  readonly ticketSubject: string;
  readonly contactId: string;
  readonly conversationId: string;
  readonly resolution:
    | "unknown"
    | "unresolved"
    | "proposed_fix_awaiting_confirmation"
    | "resolved";
  readonly nextAction: string | null;
  readonly configuredLocale: string;
  readonly latestInboundText: string;
  readonly provider: "simulator" | "meta";
  readonly recipientIdentityId: string;
  readonly recipientAddress: string;
  readonly serviceWindowOpen: boolean;
  /** Present only for a fully configured Meta channel; undefined blocks sending. */
  readonly channelConfiguration: WhatsAppChannelConfiguration | undefined;
}

/**
 * Re-check every reason not to message, immediately before messaging.
 *
 * Consent can be revoked and a contact deactivated between the call ending and
 * this job running, which is precisely the window a post-call follow-up lives
 * in. The customer-service window is read here for a truthful ticket state; the
 * outbound admission path re-enforces it independently and is the authority.
 */
export async function loadFollowupPlan(
  sql: postgres.TransactionSql,
  attemptId: string,
): Promise<FollowupPlan | "blocked_consent" | undefined> {
  const id = identifier(attemptId, "call attempt identifier");
  const rows = await sql<
    {
      ticket_id: string;
      reference: string;
      subject: string;
      contact_id: string;
      conversation_id: string | null;
      resolution_classification: FollowupPlan["resolution"];
      next_action: string | null;
      ticket_status: string;
      whatsapp_consent: string;
      opted_out_at: Date | null;
      lifecycle_status: string;
    }[]
  >`
    SELECT ticket.id AS ticket_id, ticket.reference, ticket.subject,
           ticket.contact_id, ticket.source_conversation_id AS conversation_id,
           ticket.resolution_classification, ticket.next_action,
           ticket.status AS ticket_status, contact.whatsapp_consent,
           contact.whatsapp_opted_out_at AS opted_out_at, contact.lifecycle_status
    FROM support.ticket_call_attempts attempt
    JOIN support.tickets ticket
      ON ticket.tenant_id = attempt.tenant_id AND ticket.id = attempt.ticket_id
    JOIN crm.contacts contact
      ON contact.tenant_id = ticket.tenant_id AND contact.id = ticket.contact_id
    WHERE attempt.tenant_id = platform.current_tenant_id()
      AND attempt.id = ${id}::uuid
    FOR SHARE OF contact
  `;
  const row = rows[0];
  if (row === undefined) return undefined;
  // Consent is checked before the channel is even resolved: withdrawal is a
  // fact about the person, and reporting "no target" for someone who opted out
  // would record the wrong reason on the ticket.
  if (
    row.opted_out_at !== null ||
    row.whatsapp_consent !== "granted" ||
    row.lifecycle_status !== "active"
  )
    return "blocked_consent";
  if (row.conversation_id === null) return undefined;
  const channel = await sql<
    {
      provider: "simulator" | "meta";
      identity_id: string;
      address: string;
      locale: string | null;
      latest_inbound_text: string | null;
      window_open: boolean;
      configuration: unknown;
    }[]
  >`
    SELECT channel.provider, identity.id AS identity_id,
           identity.normalized_value AS address,
           latest.content_text AS latest_inbound_text,
           channel.configuration, settings.locale,
           (conversation.customer_service_window_expires_at IS NOT NULL
            AND conversation.customer_service_window_expires_at > CURRENT_TIMESTAMP)
             AS window_open
    FROM messaging.conversations conversation
    JOIN messaging.channels channel
      ON channel.id = conversation.channel_id AND channel.tenant_id = conversation.tenant_id
     AND channel.kind = 'whatsapp' AND channel.status = 'active'
    JOIN LATERAL (
      SELECT candidate.id, candidate.normalized_value
      FROM crm.contact_channel_identities candidate
      WHERE candidate.tenant_id = conversation.tenant_id
        AND candidate.contact_id = conversation.contact_id
        AND candidate.channel = 'whatsapp'
        AND candidate.validation_status = 'valid'
        AND candidate.normalized_value IS NOT NULL
      ORDER BY candidate.is_primary DESC, candidate.created_at, candidate.id
      LIMIT 1
    ) identity ON true
    LEFT JOIN crm.tenant_settings settings ON settings.tenant_id = conversation.tenant_id
    LEFT JOIN LATERAL (
      SELECT message.content_text FROM messaging.messages message
      WHERE message.tenant_id = conversation.tenant_id
        AND message.conversation_id = conversation.id
        AND message.direction = 'inbound'
      ORDER BY message.created_at DESC, message.id DESC LIMIT 1
    ) latest ON true
    WHERE conversation.id = ${row.conversation_id}::uuid
      AND conversation.removed_from_inbox_at IS NULL
    LIMIT 1
  `;
  const target = channel[0];
  if (target === undefined) return undefined;
  const configuration =
    target.configuration !== null &&
    typeof target.configuration === "object" &&
    !Array.isArray(target.configuration)
      ? (target.configuration as Readonly<Record<string, unknown>>)
      : {};
  const channelConfiguration =
    target.provider === "meta" &&
    typeof configuration.graphApiVersion === "string" &&
    typeof configuration.phoneNumberId === "string" &&
    typeof configuration.wabaId === "string"
      ? {
          graphApiVersion: configuration.graphApiVersion,
          phoneNumberId: configuration.phoneNumberId,
          wabaId: configuration.wabaId,
        }
      : undefined;
  return {
    attemptId: id,
    ticketId: row.ticket_id,
    ticketReference: row.reference,
    ticketSubject: row.subject,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    resolution: row.resolution_classification,
    nextAction: row.next_action,
    configuredLocale: target.locale ?? "he",
    // The customer's own last words, so the caller can pick the language the
    // same way every other outbound reply does rather than assuming the
    // tenant's default is the one this person writes in.
    latestInboundText: target.latest_inbound_text ?? "",
    provider: target.provider,
    recipientIdentityId: target.identity_id,
    recipientAddress: target.address,
    serviceWindowOpen: target.window_open,
    channelConfiguration,
  };
}

/**
 * The wrap-up text, written here rather than by a model.
 *
 * Same rule the WhatsApp agent already follows: the model may choose what to
 * say, the repository supplies the words that get delivered. A wrap-up quoting
 * a model's own summary back at the customer would be the one message in the
 * journey that can assert a resolution nobody verified.
 *
 * The reply contract is numbered because a number is unambiguous in both
 * languages and survives a customer typing it with or without punctuation; the
 * words are offered too, and the classifier accepts either.
 */
export function followupMessage(plan: {
  readonly resolution: FollowupPlan["resolution"];
  readonly ticketReference: string;
  readonly ticketSubject: string;
  /**
   * Already checked by the caller against the same safety guard every other
   * delivered reply passes, or null. Model prose reaches a customer only after
   * that gate, never because it happened to be stored on the ticket.
   */
  readonly nextAction: string | null;
  readonly locale: string;
}): string {
  const hebrew = plan.locale.toLowerCase().startsWith("he");
  const subject = plan.ticketSubject.slice(0, 120);
  const resolved = plan.resolution === "resolved";
  if (hebrew) {
    const opening = resolved
      ? `סיימנו עכשיו את השיחה בנושא ${subject}. לפי השיחה הבעיה נפתרה.`
      : `סיימנו את השיחה בנושא ${subject}. הפנייה עדיין פתוחה${
          plan.nextAction === null
            ? ""
            : ` והשלב הבא הוא ${plan.nextAction.slice(0, 160)}`
        }.`;
    return [
      opening,
      "אפשר להשיב כאן:",
      "1 – נפתר",
      "2 – עדיין לא עובד",
      "3 – רוצה לדבר עם נציג",
      `מספר פנייה: ${plan.ticketReference}`,
    ].join("\n");
  }
  const opening = resolved
    ? `We have just finished our call about ${subject}. From the call, the issue is resolved.`
    : `We have finished our call about ${subject}. The ticket is still open${
        plan.nextAction === null
          ? ""
          : ` and the next step is ${plan.nextAction.slice(0, 160)}`
      }.`;
  return [
    opening,
    "You can reply here:",
    "1 – Solved",
    "2 – Still need help",
    "3 – Talk to a person",
    `Ticket number: ${plan.ticketReference}`,
  ].join("\n");
}

export interface AwaitingTicket {
  readonly ticketId: string;
  readonly reference: string;
  readonly attemptId: string | null;
}

/**
 * The issue a wrap-up reply is answering, if there is one.
 *
 * Scoped to a ticket this conversation is actually about, still open, still
 * waiting on the customer, and whose follow-up was actually delivered. Without
 * all four, an inbound message is just an inbound message and the ticket is
 * left alone.
 */
export async function awaitingCustomerTicket(
  sql: postgres.TransactionSql,
  conversationId: string,
): Promise<AwaitingTicket | undefined> {
  const id = identifier(conversationId, "conversation identifier");
  const rows = await sql<
    { ticket_id: string; reference: string; attempt_id: string | null }[]
  >`
    SELECT ticket.id AS ticket_id, ticket.reference,
           (SELECT attempt.id FROM support.ticket_call_attempts attempt
            WHERE attempt.tenant_id = ticket.tenant_id
              AND attempt.ticket_id = ticket.id
              AND attempt.followup_state = 'sent'
            ORDER BY attempt.attempt_number DESC LIMIT 1) AS attempt_id
    FROM support.tickets ticket
    WHERE ticket.tenant_id = platform.current_tenant_id()
      AND ticket.source_conversation_id = ${id}::uuid
      AND ticket.status = 'open' AND ticket.stage = 'awaiting_customer'
    ORDER BY ticket.last_activity_at DESC, ticket.id DESC
    LIMIT 1
    FOR UPDATE OF ticket
  `;
  const row = rows[0];
  if (row?.attempt_id == null) return undefined;
  return {
    ticketId: row.ticket_id,
    reference: row.reference,
    attemptId: row.attempt_id,
  };
}

export type CustomerConfirmationResult =
  "resolved" | "still_open" | "escalated" | "ignored";

/**
 * Let the customer's own answer be the confirmation, and only their answer.
 *
 * This is the one place `resolution_confirmed_by = 'customer'` can be written
 * from WhatsApp, and it is written from an explicit reply to an explicit
 * question about a specific ticket. The ticket closes here because the customer
 * has now been asked and has answered — which is the evidence the whole
 * pipeline has been holding out for.
 */
export async function applyCustomerConfirmation(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  input: {
    readonly ticketId: string;
    readonly intent: "confirmed_resolved" | "still_broken" | "wants_human";
    readonly messageId: string;
  },
): Promise<CustomerConfirmationResult> {
  const ticketId = identifier(input.ticketId, "ticket identifier");
  const messageId = identifier(input.messageId, "message identifier");
  if (input.intent === "confirmed_resolved") {
    const rows = await sql<{ id: string }[]>`
      UPDATE support.tickets
      SET status = 'closed', stage = 'closed', closure_reason = 'resolved',
          resolution_classification = 'resolved',
          resolution_confirmed_by = 'customer',
          closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = platform.current_tenant_id() AND id = ${ticketId}::uuid
        AND status = 'open' AND stage = 'awaiting_customer'
      RETURNING id
    `;
    if (rows[0] === undefined) return "ignored";
    await recordTicketEvent(sql, actorUserId, {
      ticketId,
      kind: "customer_update",
      actorKind: "customer",
      summarySafe: "Customer confirmed on WhatsApp that the issue is resolved.",
      visibility: "customer_visible",
      evidence: { messageId, confirmation: "customer_whatsapp" },
    });
    return "resolved";
  }
  const stage =
    input.intent === "wants_human" ? "awaiting_human" : "ai_handling";
  const rows = await sql<{ id: string }[]>`
    UPDATE support.tickets
    SET stage = ${stage}, resolution_classification = 'unresolved',
        resolution_confirmed_by = 'none',
        updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${ticketId}::uuid
      AND status = 'open' AND stage = 'awaiting_customer'
    RETURNING id
  `;
  if (rows[0] === undefined) return "ignored";
  await recordTicketEvent(sql, actorUserId, {
    ticketId,
    kind: "customer_update",
    actorKind: "customer",
    summarySafe:
      input.intent === "wants_human"
        ? "Customer asked for a person after the call."
        : "Customer reported the issue is not fixed.",
    visibility: "customer_visible",
    evidence: { messageId, intent: input.intent },
  });
  if (input.intent === "wants_human") {
    await setTicketHandlingMode(
      sql,
      actorUserId,
      ticketId,
      "human",
      "Customer requested a person after the call.",
    );
    return "escalated";
  }
  return "still_open";
}

export interface CallEvidence {
  readonly whatsAppMessageIds: readonly string[];
  readonly actionReceiptIds: readonly string[];
  readonly operatorNoteIds: readonly string[];
  readonly whatsAppContext: readonly {
    readonly id: string;
    readonly direction: "inbound" | "outbound";
    readonly text: string;
    readonly occurredAt: string;
  }[];
  /**
   * The tenant's configured language, and the customer's last inbound words so
   * the caller can detect theirs. A summary written in the wrong language is
   * unreadable to the operator who has to act on it.
   */
  readonly configuredLocale: string;
  readonly latestInboundText: string;
}

/**
 * The evidence a source reference may point at, loaded from the database.
 *
 * Bounded twice: by row count, so a long thread cannot become an unbounded
 * prompt, and by the tenant's own data, so a model cannot cite a message that
 * belongs to somebody else. The receipt list is what makes "completed action"
 * mean something — handoffs and service cases the PLATFORM created, never
 * anything spoken.
 */
export async function loadCallEvidence(
  sql: postgres.TransactionSql,
  input: {
    readonly ticketId: string;
    readonly conversationId: string | null;
    readonly contactId: string;
    readonly messageLimit?: number;
  },
): Promise<CallEvidence> {
  const ticketId = identifier(input.ticketId, "ticket identifier");
  const contactId = identifier(input.contactId, "contact identifier");
  const limit = Math.min(Math.max(input.messageLimit ?? 30, 1), 60);
  const messages =
    input.conversationId === null
      ? []
      : await sql<
          {
            id: string;
            direction: "inbound" | "outbound";
            content_text: string | null;
            created_at: Date;
          }[]
        >`
          SELECT id, direction, content_text, created_at
          FROM messaging.messages
          WHERE tenant_id = platform.current_tenant_id()
            AND conversation_id = ${input.conversationId}::uuid
            AND content_type = 'text' AND content_text IS NOT NULL
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}
        `;
  // Receipts the PLATFORM issued. A handoff and a service case are records of
  // something that happened; a sentence in the call is not, however confidently
  // it was said, which is the entire point of keeping this list authoritative.
  const receipts = await sql<{ id: string }[]>`
    (SELECT handoff.id FROM automation.handoffs handoff
     WHERE handoff.tenant_id = platform.current_tenant_id()
       AND handoff.contact_id = ${contactId}::uuid
     ORDER BY handoff.requested_at DESC LIMIT 10)
    UNION ALL
    (SELECT service_case.id FROM service.cases service_case
     WHERE service_case.tenant_id = platform.current_tenant_id()
       AND service_case.contact_id = ${contactId}::uuid
     ORDER BY service_case.created_at DESC LIMIT 10)
  `;
  const notes = await sql<{ id: string }[]>`
    SELECT event.id FROM support.ticket_events event
    WHERE event.tenant_id = platform.current_tenant_id()
      AND event.ticket_id = ${ticketId}::uuid AND event.kind = 'human_note'
    ORDER BY event.sequence DESC LIMIT 10
  `;
  const settings = await sql<{ locale: string }[]>`
    SELECT locale FROM crm.tenant_settings
    WHERE tenant_id = platform.current_tenant_id()
  `;
  const context = messages
    .map((message) => ({
      id: message.id,
      direction: message.direction,
      text: (message.content_text ?? "")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 600),
      occurredAt: message.created_at.toISOString(),
    }))
    .filter((message) => message.text.length > 0)
    .reverse();
  return {
    whatsAppMessageIds: context.map((message) => message.id),
    actionReceiptIds: receipts.map((row) => row.id),
    operatorNoteIds: notes.map((row) => row.id),
    whatsAppContext: context,
    configuredLocale: settings[0]?.locale ?? "he",
    latestInboundText:
      context.findLast((message) => message.direction === "inbound")?.text ??
      "",
  };
}

/**
 * Note an operator's own edit on the issue rather than letting it overwrite.
 *
 * The stored analysis is never rewritten. What an operator changes is what the
 * ticket says, and the change is recorded beside the original so the two can be
 * compared later.
 */
export async function recordOperatorSummaryEdit(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: {
    readonly ticketId: string;
    readonly summarySafe: string;
    readonly nextAction?: string | null;
  },
): Promise<boolean> {
  const ticketId = identifier(input.ticketId, "ticket identifier");
  const summary = bounded(input.summarySafe, "operator summary", 2000);
  const rows = await sql<{ id: string }[]>`
    UPDATE support.tickets
    SET next_action = COALESCE(${input.nextAction ?? null}, next_action),
        last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = platform.current_tenant_id() AND id = ${ticketId}::uuid
    RETURNING id
  `;
  if (rows[0] === undefined) return false;
  await recordTicketEvent(sql, actorUserId, {
    ticketId,
    kind: "human_note",
    actorKind: "human",
    summarySafe: summary,
    evidence: { edited: "summary" },
  });
  await sql`
    INSERT INTO audit.records
      (tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (platform.current_tenant_id(), ${actorUserId}::uuid,
            'support.ticket.summary_edited', 'support_ticket', ${ticketId}::uuid,
            ${sql.json(databaseJson({ nextActionChanged: input.nextAction !== undefined }))})
  `;
  return true;
}
