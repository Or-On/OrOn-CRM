"""bind WhatsApp sender and callback authorization

Revision ID: 8d3a9f0c2b71
Revises: 6f1c8a2d4e90
Create Date: 2026-09-15 18:10:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8d3a9f0c2b71"
down_revision: str | None = "6f1c8a2d4e90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "inbound_message_origins",
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.UUID(), nullable=False),
        sa.Column("contact_identity_id", sa.UUID(), nullable=False),
        sa.Column("sender_address", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "message_id"],
            ["messaging.messages.tenant_id", "messaging.messages.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_identity_id"],
            [
                "crm.contact_channel_identities.tenant_id",
                "crm.contact_channel_identities.id",
            ],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "sender_address ~ '^\\+[1-9][0-9]{7,14}$'",
            name="ck_inbound_message_origin_e164",
        ),
        sa.PrimaryKeyConstraint("tenant_id", "message_id"),
        schema="messaging",
    )
    op.create_index(
        "ix_inbound_message_origins_identity",
        "inbound_message_origins",
        ["tenant_id", "contact_identity_id", "message_id"],
        schema="messaging",
    )
    op.execute("ALTER TABLE messaging.inbound_message_origins ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE messaging.inbound_message_origins FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY inbound_message_origins_tenant_isolation "
        "ON messaging.inbound_message_origins "
        "USING (tenant_id = platform.current_tenant_id()) "
        "WITH CHECK (tenant_id = platform.current_tenant_id())"
    )
    op.execute("GRANT SELECT, INSERT ON messaging.inbound_message_origins TO platform_messaging")
    op.execute("GRANT SELECT ON messaging.inbound_message_origins TO platform_web")
    op.execute("GRANT SELECT ON messaging.inbound_message_origins TO platform_readonly")

    op.add_column(
        "outbound_requests",
        sa.Column("recipient_address", sa.Text(), nullable=True),
        schema="messaging",
    )
    # A current identity value cannot prove the destination authorized when a
    # legacy queued request was created. Quarantine every pre-snapshot request
    # before consulting mutable identity state. Terminal rows can then be
    # backfilled only for audit display and are never eligible for dispatch.
    op.execute(
        """
        INSERT INTO audit.records(
          tenant_id, actor_service, action, target_type, target_id, metadata
        )
        SELECT request.tenant_id, 'schema_migration',
               'whatsapp.outbound.legacy_quarantined',
               'messaging.outbound_request', request.id,
               jsonb_build_object(
                 'previousStatus', request.status,
                 'reasonCode', 'legacy_recipient_binding_unavailable'
               )
        FROM messaging.outbound_requests request
        WHERE request.status IN ('queued', 'sending')
        """
    )
    op.execute(
        """
        UPDATE messaging.messages message
        SET status='failed', updated_at=CURRENT_TIMESTAMP
        FROM messaging.outbound_requests request
        WHERE request.message_id=message.id
          AND request.tenant_id=message.tenant_id
          AND request.status IN ('queued', 'sending')
          AND message.status IN ('pending', 'queued')
        """
    )
    op.execute(
        """
        UPDATE ops.jobs job
        SET status='dead', max_attempts=GREATEST(attempts, 1),
            completed_at=CURRENT_TIMESTAMP, locked_at=NULL, locked_by=NULL,
            last_error_safe='legacy recipient binding unavailable',
            updated_at=CURRENT_TIMESTAMP
        FROM messaging.outbound_requests request
        WHERE job.job_type='whatsapp.outbound.send'
          AND job.reference_type='outbound_request'
          AND job.reference_id=request.id
          AND job.tenant_id=request.tenant_id
          AND request.status IN ('queued', 'sending')
          AND job.status IN ('queued', 'running', 'retry')
        """
    )
    op.execute(
        """
        UPDATE messaging.outbound_requests
        SET status='failed', recipient_address=NULL,
            completed_at=CURRENT_TIMESTAMP,
            last_error_code='legacy_recipient_binding_unavailable',
            updated_at=CURRENT_TIMESTAMP
        WHERE status IN ('queued', 'sending')
        """
    )
    op.execute(
        """
        UPDATE messaging.outbound_requests request
        SET recipient_address=identity.normalized_value
        FROM crm.contact_channel_identities identity
        WHERE identity.tenant_id=request.tenant_id
          AND identity.id=request.recipient_identity_id
          AND identity.normalized_value ~ '^\\+[1-9][0-9]{7,14}$'
          AND request.status IN ('sent', 'delivered', 'read', 'failed')
          AND request.last_error_code IS DISTINCT FROM 'legacy_recipient_binding_unavailable'
        """
    )
    op.create_check_constraint(
        "ck_outbound_request_recipient_e164",
        "outbound_requests",
        "recipient_address ~ '^\\+[1-9][0-9]{7,14}$' OR "
        "(recipient_address IS NULL AND status IN ('sent','delivered','read','failed'))",
        schema="messaging",
    )
    op.execute(
        """
        CREATE FUNCTION messaging.protect_outbound_recipient_binding()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog
        AS $$
        BEGIN
          IF NEW.recipient_identity_id IS DISTINCT FROM OLD.recipient_identity_id
             OR NEW.recipient_address IS DISTINCT FROM OLD.recipient_address THEN
            RAISE EXCEPTION 'outbound recipient binding is immutable';
          END IF;
          RETURN NEW;
        END
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION messaging.protect_outbound_recipient_binding() FROM PUBLIC")
    op.execute(
        "CREATE TRIGGER trg_protect_outbound_recipient_binding "
        "BEFORE UPDATE ON messaging.outbound_requests FOR EACH ROW "
        "EXECUTE FUNCTION messaging.protect_outbound_recipient_binding()"
    )

    op.add_column(
        "jobs",
        sa.Column("callback_trigger_message_id", sa.UUID(), nullable=True),
        schema="ops",
    )
    op.add_column(
        "jobs",
        sa.Column("callback_sender_identity_id", sa.UUID(), nullable=True),
        schema="ops",
    )
    op.add_column(
        "jobs",
        sa.Column("callback_destination", sa.Text(), nullable=True),
        schema="ops",
    )
    op.create_foreign_key(
        "fk_jobs_callback_trigger_message",
        "jobs",
        "messages",
        ["tenant_id", "callback_trigger_message_id"],
        ["tenant_id", "id"],
        source_schema="ops",
        referent_schema="messaging",
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_jobs_callback_sender_identity",
        "jobs",
        "contact_channel_identities",
        ["tenant_id", "callback_sender_identity_id"],
        ["tenant_id", "id"],
        source_schema="ops",
        referent_schema="crm",
        ondelete="CASCADE",
    )
    # Old terminal receipts remain auditable but cannot be replayed. Any old
    # non-terminal callback was authorized before immutable sender binding and
    # is therefore failed closed instead of being migrated by guesswork.
    op.execute(
        """
        INSERT INTO audit.records(
          tenant_id, actor_service, action, target_type, target_id, metadata
        )
        SELECT job.tenant_id, 'schema_migration',
               'conversation.callback.legacy_quarantined', 'job', job.id,
               jsonb_build_object(
                 'previousStatus', job.status,
                 'reasonCode', 'legacy_callback_authorization_unavailable'
               )
        FROM ops.jobs job
        WHERE job.job_type='whatsapp.ai.call'
          AND job.status IN ('queued', 'running', 'retry')
        """
    )
    op.execute(
        """
        UPDATE ops.jobs
        SET status='dead', max_attempts=GREATEST(attempts, 1), completed_at=CURRENT_TIMESTAMP,
            locked_at=NULL, locked_by=NULL,
            last_error_safe='legacy callback authorization requires a new customer request',
            updated_at=CURRENT_TIMESTAMP
        WHERE job_type='whatsapp.ai.call'
          AND status IN ('queued', 'running', 'retry')
        """
    )
    op.create_check_constraint(
        "ck_jobs_callback_authorization",
        "jobs",
        """
        job_type <> 'whatsapp.ai.call'
        OR (
          tenant_id IS NOT NULL
          AND reference_type = 'conversation'
          AND callback_trigger_message_id IS NOT NULL
          AND callback_sender_identity_id IS NOT NULL
          AND callback_destination ~ '^\\+[1-9][0-9]{7,14}$'
        )
        OR (
          status IN ('succeeded', 'dead', 'cancelled')
          AND callback_trigger_message_id IS NULL
          AND callback_sender_identity_id IS NULL
          AND callback_destination IS NULL
        )
        """,
        schema="ops",
    )
    op.create_index(
        "uq_jobs_whatsapp_callback_trigger",
        "jobs",
        ["tenant_id", "callback_trigger_message_id"],
        unique=True,
        schema="ops",
        postgresql_where=sa.text(
            "job_type = 'whatsapp.ai.call' AND callback_trigger_message_id IS NOT NULL"
        ),
    )
    op.execute(
        """
        CREATE FUNCTION ops.protect_whatsapp_callback_authorization()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog
        AS $$
        BEGIN
          IF OLD.job_type = 'whatsapp.ai.call' OR NEW.job_type = 'whatsapp.ai.call' THEN
            IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
               OR NEW.queue IS DISTINCT FROM OLD.queue
               OR NEW.job_type IS DISTINCT FROM OLD.job_type
               OR NEW.reference_type IS DISTINCT FROM OLD.reference_type
               OR NEW.reference_id IS DISTINCT FROM OLD.reference_id
               OR NEW.payload IS DISTINCT FROM OLD.payload
               OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
               OR NEW.callback_trigger_message_id IS DISTINCT FROM OLD.callback_trigger_message_id
               OR NEW.callback_sender_identity_id IS DISTINCT FROM OLD.callback_sender_identity_id
               OR NEW.callback_destination IS DISTINCT FROM OLD.callback_destination THEN
              RAISE EXCEPTION 'WhatsApp callback authorization is immutable';
            END IF;
          END IF;
          RETURN NEW;
        END
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION ops.protect_whatsapp_callback_authorization() FROM PUBLIC")
    op.execute(
        "CREATE TRIGGER trg_protect_whatsapp_callback_authorization "
        "BEFORE UPDATE ON ops.jobs FOR EACH ROW "
        "EXECUTE FUNCTION ops.protect_whatsapp_callback_authorization()"
    )


def downgrade() -> None:
    # The predecessor runtime has no immutable recipient/callback binding.
    # Quarantine all protected work before removing those guarantees so a
    # rolling rollback cannot reinterpret or redirect an already queued action.
    # Follow outbound admission's lock order and hold every lock until the
    # migration transaction commits. Workers must be drained before downgrade
    # because they claim ops.jobs first; no single table order can safely race
    # both admission and active workers.
    op.execute(
        """
        LOCK TABLE messaging.outbound_requests,
                   messaging.messages,
                   messaging.inbound_message_origins,
                   ops.jobs
        IN ACCESS EXCLUSIVE MODE
        """
    )
    op.execute(
        """
        INSERT INTO audit.records(
          tenant_id, actor_service, action, target_type, target_id, metadata
        )
        SELECT request.tenant_id, 'schema_migration',
               'whatsapp.outbound.downgrade_quarantined',
               'messaging.outbound_request', request.id,
               jsonb_build_object(
                 'previousStatus', request.status,
                 'reasonCode', 'recipient_binding_removed_by_downgrade'
               )
        FROM messaging.outbound_requests request
        WHERE request.status IN ('queued', 'sending')
        """
    )
    op.execute(
        """
        UPDATE messaging.messages message
        SET status='failed', updated_at=CURRENT_TIMESTAMP
        FROM messaging.outbound_requests request
        WHERE request.message_id=message.id
          AND request.tenant_id=message.tenant_id
          AND request.status IN ('queued', 'sending')
          AND message.status IN ('pending', 'queued')
        """
    )
    op.execute(
        """
        UPDATE ops.jobs job
        SET status='dead', max_attempts=GREATEST(attempts, 1),
            completed_at=CURRENT_TIMESTAMP, locked_at=NULL, locked_by=NULL,
            last_error_safe='recipient binding removed by downgrade',
            updated_at=CURRENT_TIMESTAMP
        FROM messaging.outbound_requests request
        WHERE job.job_type='whatsapp.outbound.send'
          AND job.reference_type='outbound_request'
          AND job.reference_id=request.id
          AND job.tenant_id=request.tenant_id
          AND request.status IN ('queued', 'sending')
          AND job.status IN ('queued', 'running', 'retry')
        """
    )
    op.execute(
        """
        UPDATE messaging.outbound_requests
        SET status='failed', completed_at=CURRENT_TIMESTAMP,
            last_error_code='recipient_binding_removed_by_downgrade',
            updated_at=CURRENT_TIMESTAMP
        WHERE status IN ('queued', 'sending')
        """
    )
    op.execute(
        """
        INSERT INTO audit.records(
          tenant_id, actor_service, action, target_type, target_id, metadata
        )
        SELECT job.tenant_id, 'schema_migration',
               'conversation.callback.downgrade_quarantined', 'job', job.id,
               jsonb_build_object(
                 'previousStatus', job.status,
                 'reasonCode', 'callback_binding_removed_by_downgrade'
               )
        FROM ops.jobs job
        WHERE job.job_type='whatsapp.ai.call'
          AND job.status IN ('queued', 'running', 'retry')
        """
    )
    op.execute(
        """
        UPDATE ops.jobs
        SET status='dead', max_attempts=GREATEST(attempts, 1),
            completed_at=CURRENT_TIMESTAMP, locked_at=NULL, locked_by=NULL,
            last_error_safe='callback binding removed by downgrade',
            updated_at=CURRENT_TIMESTAMP
        WHERE job_type='whatsapp.ai.call'
          AND status IN ('queued', 'running', 'retry')
        """
    )

    op.execute("DROP TRIGGER trg_protect_whatsapp_callback_authorization ON ops.jobs")
    op.execute("DROP FUNCTION ops.protect_whatsapp_callback_authorization()")
    op.drop_index("uq_jobs_whatsapp_callback_trigger", table_name="jobs", schema="ops")
    op.drop_constraint("ck_jobs_callback_authorization", "jobs", schema="ops", type_="check")
    op.drop_constraint("fk_jobs_callback_sender_identity", "jobs", schema="ops", type_="foreignkey")
    op.drop_constraint("fk_jobs_callback_trigger_message", "jobs", schema="ops", type_="foreignkey")
    op.drop_column("jobs", "callback_destination", schema="ops")
    op.drop_column("jobs", "callback_sender_identity_id", schema="ops")
    op.drop_column("jobs", "callback_trigger_message_id", schema="ops")

    op.execute("DROP TRIGGER trg_protect_outbound_recipient_binding ON messaging.outbound_requests")
    op.execute("DROP FUNCTION messaging.protect_outbound_recipient_binding()")
    op.drop_constraint(
        "ck_outbound_request_recipient_e164",
        "outbound_requests",
        schema="messaging",
        type_="check",
    )
    op.drop_column("outbound_requests", "recipient_address", schema="messaging")

    op.execute("REVOKE SELECT ON messaging.inbound_message_origins FROM platform_readonly")
    op.execute("REVOKE SELECT ON messaging.inbound_message_origins FROM platform_web")
    op.execute("REVOKE SELECT, INSERT ON messaging.inbound_message_origins FROM platform_messaging")
    op.drop_index(
        "ix_inbound_message_origins_identity",
        table_name="inbound_message_origins",
        schema="messaging",
    )
    op.drop_table("inbound_message_origins", schema="messaging")
