"""fence messaging worker claims and ownership

Revision ID: 2b2b64433c98
Revises: eb2660eb37ec
Create Date: 2026-09-12 19:42:20.375275
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "2b2b64433c98"
down_revision: str | None = "eb2660eb37ec"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("ownership_epoch", sa.BigInteger(), nullable=False, server_default="0"),
        schema="messaging",
    )
    op.add_column(
        "outbound_requests",
        sa.Column("ai_ownership_epoch", sa.BigInteger(), nullable=True),
        schema="messaging",
    )
    op.add_column(
        "outbound_requests",
        sa.Column("request_fingerprint", sa.Text(), nullable=True),
        schema="messaging",
    )
    op.execute("""
      CREATE FUNCTION messaging.advance_ownership_epoch() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $$
      BEGIN
        IF ROW(NEW.ownership_mode, NEW.ai_agent_profile_version_id,
               NEW.ai_enabled_by_user_id, NEW.ai_enabled_at)
           IS DISTINCT FROM ROW(OLD.ownership_mode, OLD.ai_agent_profile_version_id,
               OLD.ai_enabled_by_user_id, OLD.ai_enabled_at)
        THEN NEW.ownership_epoch := OLD.ownership_epoch + 1;
        ELSE NEW.ownership_epoch := OLD.ownership_epoch;
        END IF;
        RETURN NEW;
      END $$;
    """)
    op.execute("REVOKE ALL ON FUNCTION messaging.advance_ownership_epoch() FROM PUBLIC")
    op.execute("""
      CREATE TRIGGER conversation_ownership_epoch BEFORE UPDATE ON messaging.conversations
      FOR EACH ROW EXECUTE FUNCTION messaging.advance_ownership_epoch();
    """)
    _claims(scoped=True)


def downgrade() -> None:
    _claims(scoped=False)
    op.execute("DROP TRIGGER conversation_ownership_epoch ON messaging.conversations")
    op.execute("DROP FUNCTION messaging.advance_ownership_epoch()")
    op.drop_column("outbound_requests", "ai_ownership_epoch", schema="messaging")
    op.drop_column("outbound_requests", "request_fingerprint", schema="messaging")
    op.drop_column("conversations", "ownership_epoch", schema="messaging")


def _claims(*, scoped: bool) -> None:
    # Historical definitions remain untouched. Worker-specific functions cannot
    # claim a LiveKit event or a voice queue, even with arbitrary SQL arguments.
    inbound_scope = (
        "AND provider = 'meta' AND tenant_id IS NOT NULL "
        "AND event_type IN ('whatsapp.message.text','whatsapp.message.status')"
        if scoped
        else ""
    )
    job_scope = "AND p_queue = 'messaging' AND tenant_id IS NOT NULL" if scoped else ""
    # Interpolated scopes below are fixed literals chosen only by upgrade/downgrade.
    op.execute(f"""
      CREATE OR REPLACE FUNCTION ops.claim_inbound_events(
        p_worker_id text, p_limit integer DEFAULT 10, p_lease_seconds integer DEFAULT 300)
      RETURNS SETOF ops.inbound_events LANGUAGE sql
      SECURITY DEFINER SET search_path = pg_catalog AS $$
        WITH candidates AS (
          SELECT id FROM ops.inbound_events WHERE attempts < max_attempts {inbound_scope}
          AND ((status IN ('received','failed') AND available_at <= CURRENT_TIMESTAMP)
            OR (status = 'processing' AND locked_at < CURRENT_TIMESTAMP
              - make_interval(secs => GREATEST(1,p_lease_seconds))))
          ORDER BY available_at, received_at, id FOR UPDATE SKIP LOCKED
          LIMIT LEAST(GREATEST(p_limit,1),100)
        ) UPDATE ops.inbound_events event SET status='processing', attempts=event.attempts+1,
          locked_at=CURRENT_TIMESTAMP, locked_by=p_worker_id FROM candidates
          WHERE event.id=candidates.id RETURNING event.*
      $$;
    """)  # noqa: S608 — fixed migration scope, no caller-controlled SQL
    op.execute(f"""
      CREATE OR REPLACE FUNCTION ops.claim_jobs_all_tenants(
        p_worker_id text, p_queue text, p_limit integer DEFAULT 10,
        p_lease_seconds integer DEFAULT 300)
      RETURNS SETOF ops.jobs LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
        WITH candidates AS (
          SELECT id FROM ops.jobs WHERE queue=p_queue AND attempts<max_attempts {job_scope}
          AND ((status IN ('queued','retry') AND available_at<=CURRENT_TIMESTAMP)
            OR (status='running' AND locked_at<CURRENT_TIMESTAMP
              -make_interval(secs=>GREATEST(1,p_lease_seconds))))
          ORDER BY priority DESC,available_at,id FOR UPDATE SKIP LOCKED
          LIMIT LEAST(GREATEST(p_limit,1),100)
        ) UPDATE ops.jobs job SET status='running',attempts=job.attempts+1,
          locked_at=CURRENT_TIMESTAMP,
          locked_by=p_worker_id,updated_at=CURRENT_TIMESTAMP FROM candidates
          WHERE job.id=candidates.id RETURNING job.*
      $$;
    """)  # noqa: S608 — fixed migration scope, no caller-controlled SQL
    complete_scope = "AND event.provider='meta' AND event.tenant_id IS NOT NULL" if scoped else ""
    op.execute(f"""
      CREATE OR REPLACE FUNCTION ops.complete_inbound_event(p_event_id uuid,p_worker_id text)
      RETURNS ops.inbound_events LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
        UPDATE ops.inbound_events event SET status='processed',processed_at=CURRENT_TIMESTAMP,
          locked_at=NULL,locked_by=NULL,last_error_safe=NULL
        WHERE event.id=p_event_id AND event.status='processing' AND event.locked_by=p_worker_id
          {complete_scope} RETURNING event.*
      $$
    """)  # noqa: S608 — fixed migration scope, no caller-controlled SQL
    op.execute(f"""
      CREATE OR REPLACE FUNCTION ops.fail_inbound_event(
        p_event_id uuid,p_worker_id text,p_error_safe text,p_retry_delay_seconds integer)
      RETURNS ops.inbound_events LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
        UPDATE ops.inbound_events event SET status='failed',
          available_at=CASE WHEN event.attempts>=event.max_attempts THEN event.available_at
            ELSE CURRENT_TIMESTAMP + make_interval(secs=>LEAST(86400.0,
              GREATEST(p_retry_delay_seconds,1)*power(2.0,LEAST(GREATEST(event.attempts-1,0),16))
              +random()*GREATEST(p_retry_delay_seconds,1))) END,
          locked_at=NULL,locked_by=NULL,last_error_safe=left(p_error_safe,2000)
        WHERE event.id=p_event_id AND event.status='processing' AND event.locked_by=p_worker_id
          {complete_scope} RETURNING event.*
      $$
    """)  # noqa: S608 — fixed migration scope, no caller-controlled SQL
