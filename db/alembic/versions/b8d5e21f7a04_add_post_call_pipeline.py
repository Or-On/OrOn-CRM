"""add the durable post-call pipeline to support call attempts

A terminal telephone session owes work: verify the artifacts, analyse what was
said, update the issue, and decide whether the customer hears back. None of it
belongs in Pipecat teardown or the dispatcher's room-finalization path, which
already only owe the canonical final session write.

So the terminal session write ENQUEUES, and everything after it is durable job
processing keyed on the attempt. The stage column here is the workflow's only
authority: a duplicate webhook, a redelivered job, a worker restart and a retry
all resume the SAME attempt at the SAME stage rather than starting a second
pipeline, because every transition is a conditional UPDATE on the stage it
expects to find.

The new states are deliberately unflattering. `partial` means the media is real
and is not a complete call. `not_applicable` means there was no conversation to
summarise, which is what a busy signal produces. Neither is allowed to read as
success, and `ready` still cannot be written without the artifact that backs it.

Revision ID: b8d5e21f7a04
Revises: 1b6e4d8a90c2
Create Date: 2026-09-19 09:40:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "b8d5e21f7a04"
down_revision: str | None = "1b6e4d8a90c2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # --- Allocating an attempt number ----------------------------------------
    # The same counter mechanism the timeline already uses, and for the same
    # reason: reading `max(attempt_number)+1` lets two workers racing a retry
    # compute the same number, and the unique constraint then rejects the second
    # attempt instead of numbering it.
    op.execute("""
        ALTER TABLE support.tickets
          ADD COLUMN next_attempt_number integer NOT NULL DEFAULT 0
    """)
    # One dial admission is one attempt, however many times its job is
    # redelivered. The job id is the admission, so it is the idempotency key.
    op.execute("""
        CREATE UNIQUE INDEX uq_support_call_attempts_job
          ON support.ticket_call_attempts (tenant_id, job_id)
          WHERE job_id IS NOT NULL
    """)

    # --- Workflow position, artifact verdicts and the analysis ----------------
    # All on the attempt rather than in a parallel table: the attempt already is
    # the record of one telephone interaction, and a second table keyed to it
    # would only create a way for the two to disagree.
    op.execute("""
        ALTER TABLE support.ticket_call_attempts
          ADD COLUMN post_call_stage text NOT NULL DEFAULT 'not_started',
          ADD COLUMN post_call_attempts integer NOT NULL DEFAULT 0,
          ADD COLUMN post_call_error_safe text,
          ADD COLUMN artifacts_verified_at timestamptz,
          -- What verification actually found, in a fixed vocabulary. An
          -- operator reading "header_only" learns something a bare
          -- "unavailable" hides: the upload landed and there was no audio in it.
          ADD COLUMN recording_detail_safe text,
          ADD COLUMN recording_byte_size bigint,
          ADD COLUMN recording_duration_seconds numeric(10,3),
          ADD COLUMN transcript_state text NOT NULL DEFAULT 'pending',
          ADD COLUMN transcript_detail_safe text,
          ADD COLUMN transcript_turn_count integer,
          -- The model's structured output, kept verbatim. An operator may later
          -- edit what the ticket displays; this stays as the original evidence.
          ADD COLUMN analysis jsonb,
          ADD COLUMN analysis_schema_version text,
          ADD COLUMN analysis_model_safe text,
          ADD COLUMN analysis_completed_at timestamptz,
          ADD COLUMN followup_state text NOT NULL DEFAULT 'not_required',
          ADD COLUMN followup_message_id uuid,
          ADD COLUMN followup_sent_at timestamptz
    """)

    op.execute("""
        ALTER TABLE support.ticket_call_attempts
          ADD CONSTRAINT ck_support_attempt_post_call_stage CHECK (
            post_call_stage IN ('not_started','artifacts_pending','artifacts_verified',
                                'summary_pending','summary_ready','ticket_updated',
                                'followup_pending','complete')
          ),
          ADD CONSTRAINT ck_support_attempt_post_call_attempts CHECK (
            post_call_attempts >= 0
          ),
          ADD CONSTRAINT ck_support_attempt_transcript_state CHECK (
            transcript_state IN ('pending','valid','partial','empty','missing','failed')
          ),
          ADD CONSTRAINT ck_support_attempt_transcript_turns CHECK (
            transcript_turn_count IS NULL OR transcript_turn_count >= 0
          ),
          -- A transcript is only ever a transcript OF a call, so claiming one
          -- without the session it came from is the same mistake as claiming a
          -- recording without its object.
          ADD CONSTRAINT ck_support_attempt_transcript_needs_session CHECK (
            transcript_state NOT IN ('valid','partial') OR session_id IS NOT NULL
          ),
          ADD CONSTRAINT ck_support_attempt_analysis_object CHECK (
            analysis IS NULL OR jsonb_typeof(analysis) = 'object'
          ),
          -- The same rule the recording already has, applied to the summary: a
          -- `ready` summary state must have the analysis that makes it ready.
          ADD CONSTRAINT ck_support_attempt_summary_ready_has_analysis CHECK (
            summary_state <> 'ready'
            OR (analysis IS NOT NULL AND analysis_schema_version IS NOT NULL)
          ),
          ADD CONSTRAINT ck_support_attempt_followup_state CHECK (
            followup_state IN ('not_required','pending','sent','blocked_window',
                               'blocked_consent','failed')
          ),
          ADD CONSTRAINT ck_support_attempt_followup_sent_has_message CHECK (
            followup_state <> 'sent'
            OR (followup_message_id IS NOT NULL AND followup_sent_at IS NOT NULL)
          )
    """)
    # `followup_message_id` carries no foreign key, for the same reason
    # `session_id` beside it does not: a tenant may delete the conversation that
    # message belonged to, and a `SET NULL` there would collide with the check
    # above and make the deletion fail. The ticket keeps the reference and its
    # own record of what was sent; the UI resolves the message defensively.

    # `no_answer`, `busy` and a provider timeout produce no conversation. Before
    # this there was no way to say so: `pending` implied work still owed and
    # `failed` implied the analysis broke. Widening the vocabulary does not
    # loosen anything — `ready` gained a constraint in the same statement above.
    op.execute("""
        ALTER TABLE support.ticket_call_attempts
          DROP CONSTRAINT ck_support_attempt_summary,
          ADD CONSTRAINT ck_support_attempt_summary CHECK (
            summary_state IN ('pending','processing','ready','failed','not_applicable')
          )
    """)

    # The worker's own reconciliation view: attempts with post-call work still
    # owed. Partial, because a mature tenant's completed attempts are the vast
    # majority and must not be scanned to find the handful still moving.
    op.execute("""
        CREATE INDEX ix_support_attempts_post_call_open
          ON support.ticket_call_attempts (tenant_id, post_call_stage, updated_at)
          WHERE post_call_stage <> 'complete'
    """)

    # --- Terminal session enqueues the pipeline ------------------------------
    # SECURITY DEFINER and narrowly scoped, exactly like the field-service call
    # summary trigger next to it: the voice runtime gains the ability to cause
    # THIS one job row for a session it owns, not INSERT on the job table.
    #
    # The idempotency key is the attempt, not the delivery. LiveKit's
    # room-finished webhook and the transport's participant-left event race by
    # design, the dispatcher may replay, and a status correction updates the row
    # again — all of them arrive here and all of them find the key taken.
    op.execute("""
        CREATE FUNCTION support.enqueue_post_call(p_tenant_id uuid, p_session_id uuid)
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        DECLARE v_attempt_id uuid;
        BEGIN
          SELECT attempt.id INTO v_attempt_id
          FROM support.ticket_call_attempts attempt
          WHERE attempt.tenant_id = p_tenant_id
            AND attempt.session_id = p_session_id
            AND attempt.post_call_stage = 'not_started'
          FOR UPDATE;
          IF v_attempt_id IS NULL THEN
            RETURN;
          END IF;
          UPDATE support.ticket_call_attempts
          SET post_call_stage = 'artifacts_pending', updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = p_tenant_id AND id = v_attempt_id
            AND post_call_stage = 'not_started';
          INSERT INTO ops.jobs (
            tenant_id, queue, job_type, reference_type, reference_id, payload,
            idempotency_key, max_attempts, priority
          ) VALUES (
            p_tenant_id, 'messaging', 'support.postcall.process',
            'ticket_call_attempt', v_attempt_id,
            jsonb_build_object('attemptId', v_attempt_id, 'sessionId', p_session_id),
            'support-postcall:' || v_attempt_id::text, 6, 25
          ) ON CONFLICT DO NOTHING;
        END
        $$
    """)
    op.execute("REVOKE ALL ON FUNCTION support.enqueue_post_call(uuid, uuid) FROM PUBLIC")
    # The messaging worker binds the session onto the attempt after the
    # dispatcher accepts the dial. When the call is already terminal by then the
    # trigger had nothing to find, so the binding path calls this directly and
    # the shared idempotency key still admits exactly one pipeline.
    op.execute("""
        GRANT EXECUTE ON FUNCTION support.enqueue_post_call(uuid, uuid)
          TO platform_web, platform_messaging
    """)

    op.execute("""
        CREATE FUNCTION support.queue_post_call_from_session()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        BEGIN
          -- Only the transition matters. A usage checkpoint rewrites the row
          -- many times during one call and must not look like a call ending.
          IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
            RETURN NEW;
          END IF;
          IF NEW.status NOT IN ('ended', 'failed') THEN
            RETURN NEW;
          END IF;
          PERFORM support.enqueue_post_call(NEW.tenant_id, NEW.session_id);
          RETURN NEW;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER trg_queue_post_call_session
        AFTER UPDATE OF status ON public.sessions
        FOR EACH ROW EXECUTE FUNCTION support.queue_post_call_from_session()
    """)

    # --- Finding the issue an inbound reply answers --------------------------
    # After a wrap-up message the customer's next WhatsApp turn has to reach the
    # ticket that asked the question, without scanning the tenant's open queue
    # on every inbound message.
    op.execute("""
        CREATE INDEX ix_support_tickets_awaiting_customer
          ON support.tickets (tenant_id, source_conversation_id, last_activity_at DESC)
          WHERE status = 'open' AND stage = 'awaiting_customer'
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS support.uq_support_call_attempts_job")
    op.execute("ALTER TABLE support.tickets DROP COLUMN next_attempt_number")
    op.execute("DROP INDEX IF EXISTS support.ix_support_tickets_awaiting_customer")
    op.execute("DROP TRIGGER IF EXISTS trg_queue_post_call_session ON public.sessions")
    op.execute("DROP FUNCTION IF EXISTS support.queue_post_call_from_session()")
    op.execute("DROP FUNCTION IF EXISTS support.enqueue_post_call(uuid, uuid)")
    op.execute("DROP INDEX IF EXISTS support.ix_support_attempts_post_call_open")
    op.execute("""
        ALTER TABLE support.ticket_call_attempts
          DROP CONSTRAINT ck_support_attempt_summary,
          ADD CONSTRAINT ck_support_attempt_summary CHECK (
            summary_state IN ('pending','processing','ready','failed')
          )
    """)
    op.execute("""
        ALTER TABLE support.ticket_call_attempts
          DROP CONSTRAINT ck_support_attempt_followup_sent_has_message,
          DROP CONSTRAINT ck_support_attempt_followup_state,
          DROP CONSTRAINT ck_support_attempt_summary_ready_has_analysis,
          DROP CONSTRAINT ck_support_attempt_analysis_object,
          DROP CONSTRAINT ck_support_attempt_transcript_needs_session,
          DROP CONSTRAINT ck_support_attempt_transcript_turns,
          DROP CONSTRAINT ck_support_attempt_transcript_state,
          DROP CONSTRAINT ck_support_attempt_post_call_attempts,
          DROP CONSTRAINT ck_support_attempt_post_call_stage
    """)
    op.execute("""
        ALTER TABLE support.ticket_call_attempts
          DROP COLUMN followup_sent_at,
          DROP COLUMN followup_message_id,
          DROP COLUMN followup_state,
          DROP COLUMN analysis_completed_at,
          DROP COLUMN analysis_model_safe,
          DROP COLUMN analysis_schema_version,
          DROP COLUMN analysis,
          DROP COLUMN transcript_turn_count,
          DROP COLUMN transcript_detail_safe,
          DROP COLUMN transcript_state,
          DROP COLUMN recording_duration_seconds,
          DROP COLUMN recording_byte_size,
          DROP COLUMN recording_detail_safe,
          DROP COLUMN artifacts_verified_at,
          DROP COLUMN post_call_error_safe,
          DROP COLUMN post_call_attempts,
          DROP COLUMN post_call_stage
    """)
