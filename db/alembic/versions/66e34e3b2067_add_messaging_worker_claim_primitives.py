"""add messaging worker claim primitives

Revision ID: 66e34e3b2067
Revises: 3efa5431c380
Create Date: 2026-09-01 22:43:12.731777
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "66e34e3b2067"
down_revision: str | None = "3efa5431c380"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "inbound_events",
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        schema="ops",
    )
    op.add_column(
        "inbound_events", sa.Column("locked_at", sa.DateTime(timezone=True)), schema="ops"
    )
    op.add_column("inbound_events", sa.Column("locked_by", sa.Text()), schema="ops")
    op.add_column(
        "inbound_events",
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="8"),
        schema="ops",
    )
    op.create_check_constraint(
        "ck_inbound_event_attempt_limit",
        "inbound_events",
        "max_attempts > 0 AND attempts <= max_attempts",
        schema="ops",
    )
    op.create_check_constraint(
        "ck_inbound_event_processing_lease",
        "inbound_events",
        "status <> 'processing' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)",
        schema="ops",
    )
    op.drop_index("ix_inbound_events_pending", table_name="inbound_events", schema="ops")
    op.create_index(
        "ix_inbound_events_claim",
        "inbound_events",
        ["status", "available_at", "received_at", "id"],
        schema="ops",
        postgresql_where=sa.text("status IN ('received', 'failed', 'processing')"),
    )

    op.execute(
        """
        CREATE FUNCTION ops.accept_whatsapp_inbound(
          p_provider_account_id text,
          p_provider_event_id text,
          p_event_type text,
          p_payload jsonb
        ) RETURNS ops.inbound_events
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE
          v_tenant_id uuid;
          v_event ops.inbound_events;
        BEGIN
          SELECT channel.tenant_id INTO STRICT v_tenant_id
          FROM messaging.channels AS channel
          WHERE channel.provider = 'meta'
            AND channel.provider_account_id = p_provider_account_id
            AND channel.status = 'active';

          INSERT INTO ops.inbound_events
            (tenant_id, provider, provider_account_id, provider_event_id,
             event_type, payload)
          VALUES
            (v_tenant_id, 'meta', p_provider_account_id, p_provider_event_id,
             left(p_event_type, 200), p_payload)
          ON CONFLICT (provider, provider_account_id, provider_event_id)
          DO UPDATE SET provider_event_id = EXCLUDED.provider_event_id
          RETURNING * INTO v_event;
          RETURN v_event;
        EXCEPTION
          WHEN NO_DATA_FOUND THEN
            RAISE EXCEPTION 'unknown or inactive WhatsApp provider account'
              USING ERRCODE = '22023';
          WHEN TOO_MANY_ROWS THEN
            RAISE EXCEPTION 'ambiguous WhatsApp provider account'
              USING ERRCODE = '23505';
        END
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION ops.accept_whatsapp_inbound(text, text, text, jsonb) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION ops.accept_whatsapp_inbound(text, text, text, jsonb) "
        "TO platform_web, platform_messaging"
    )

    op.execute(
        """
        CREATE FUNCTION ops.claim_inbound_events(
          p_worker_id text,
          p_limit integer DEFAULT 10,
          p_lease_seconds integer DEFAULT 300
        ) RETURNS SETOF ops.inbound_events
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          WITH candidates AS (
            SELECT id FROM ops.inbound_events
            WHERE attempts < max_attempts
              AND (
                (status IN ('received', 'failed') AND available_at <= CURRENT_TIMESTAMP)
                OR (status = 'processing' AND locked_at < CURRENT_TIMESTAMP
                    - make_interval(secs => GREATEST(1, p_lease_seconds)))
              )
            ORDER BY available_at, received_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT LEAST(GREATEST(p_limit, 1), 100)
          )
          UPDATE ops.inbound_events AS event
          SET status = 'processing', attempts = event.attempts + 1,
              locked_at = CURRENT_TIMESTAMP, locked_by = p_worker_id
          FROM candidates
          WHERE event.id = candidates.id
          RETURNING event.*
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION ops.claim_inbound_events(text, integer, integer) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION ops.claim_inbound_events(text, integer, integer) "
        "TO platform_worker, platform_messaging"
    )

    op.execute(
        """
        CREATE FUNCTION ops.complete_inbound_event(p_event_id uuid, p_worker_id text)
        RETURNS ops.inbound_events
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          UPDATE ops.inbound_events AS event
          SET status = 'processed', processed_at = CURRENT_TIMESTAMP,
              locked_at = NULL, locked_by = NULL, last_error_safe = NULL
          WHERE event.id = p_event_id AND event.status = 'processing'
            AND event.locked_by = p_worker_id
          RETURNING event.*
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION ops.complete_inbound_event(uuid, text) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION ops.complete_inbound_event(uuid, text) "
        "TO platform_worker, platform_messaging"
    )

    op.execute(
        """
        CREATE FUNCTION ops.fail_inbound_event(
          p_event_id uuid, p_worker_id text, p_error_safe text,
          p_retry_delay_seconds integer
        ) RETURNS ops.inbound_events
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          UPDATE ops.inbound_events AS event
          SET status = 'failed',
              available_at = CASE
                WHEN event.attempts >= event.max_attempts THEN event.available_at
                ELSE CURRENT_TIMESTAMP + make_interval(
                  secs => LEAST(86400.0,
                    GREATEST(p_retry_delay_seconds, 1)
                    * power(2.0, LEAST(GREATEST(event.attempts - 1, 0), 16))
                    + random() * GREATEST(p_retry_delay_seconds, 1)))
              END,
              locked_at = NULL, locked_by = NULL,
              last_error_safe = left(p_error_safe, 2000)
          WHERE event.id = p_event_id AND event.status = 'processing'
            AND event.locked_by = p_worker_id
          RETURNING event.*
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION ops.fail_inbound_event(uuid, text, text, integer) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION ops.fail_inbound_event(uuid, text, text, integer) "
        "TO platform_worker, platform_messaging"
    )

    op.execute(
        """
        CREATE FUNCTION ops.claim_jobs_all_tenants(
          p_worker_id text,
          p_queue text,
          p_limit integer DEFAULT 10,
          p_lease_seconds integer DEFAULT 300
        ) RETURNS SETOF ops.jobs
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          WITH candidates AS (
            SELECT id FROM ops.jobs
            WHERE queue = p_queue AND attempts < max_attempts
              AND (
                (status IN ('queued', 'retry') AND available_at <= CURRENT_TIMESTAMP)
                OR (status = 'running' AND locked_at < CURRENT_TIMESTAMP
                    - make_interval(secs => GREATEST(1, p_lease_seconds)))
              )
            ORDER BY priority DESC, available_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT LEAST(GREATEST(p_limit, 1), 100)
          )
          UPDATE ops.jobs AS job
          SET status = 'running', attempts = job.attempts + 1,
              locked_at = CURRENT_TIMESTAMP, locked_by = p_worker_id,
              updated_at = CURRENT_TIMESTAMP
          FROM candidates
          WHERE job.id = candidates.id
          RETURNING job.*
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION "
        "ops.claim_jobs_all_tenants(text, text, integer, integer) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION ops.claim_jobs_all_tenants(text, text, integer, integer) "
        "TO platform_worker, platform_messaging"
    )
    op.execute("GRANT SELECT, INSERT ON ops.jobs TO platform_web")


def downgrade() -> None:
    op.execute("REVOKE SELECT, INSERT ON ops.jobs FROM platform_web")
    op.execute("DROP FUNCTION ops.claim_jobs_all_tenants(text, text, integer, integer)")
    op.execute("DROP FUNCTION ops.fail_inbound_event(uuid, text, text, integer)")
    op.execute("DROP FUNCTION ops.complete_inbound_event(uuid, text)")
    op.execute("DROP FUNCTION ops.claim_inbound_events(text, integer, integer)")
    op.execute("DROP FUNCTION ops.accept_whatsapp_inbound(text, text, text, jsonb)")
    op.drop_index("ix_inbound_events_claim", table_name="inbound_events", schema="ops")
    op.create_index(
        "ix_inbound_events_pending",
        "inbound_events",
        ["status", "received_at", "id"],
        schema="ops",
        postgresql_where=sa.text("status IN ('received', 'failed')"),
    )
    op.drop_constraint(
        "ck_inbound_event_processing_lease", "inbound_events", schema="ops", type_="check"
    )
    op.drop_constraint(
        "ck_inbound_event_attempt_limit", "inbound_events", schema="ops", type_="check"
    )
    op.drop_column("inbound_events", "max_attempts", schema="ops")
    op.drop_column("inbound_events", "locked_by", schema="ops")
    op.drop_column("inbound_events", "locked_at", schema="ops")
    op.drop_column("inbound_events", "available_at", schema="ops")
