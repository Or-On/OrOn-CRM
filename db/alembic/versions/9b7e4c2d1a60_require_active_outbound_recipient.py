"""require active WhatsApp outbound recipient snapshots

Revision ID: 9b7e4c2d1a60
Revises: 8d3a9f0c2b71
Create Date: 2026-09-15 21:30:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "9b7e4c2d1a60"
down_revision: str | None = "8d3a9f0c2b71"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # PostgreSQL CHECK constraints accept UNKNOWN. The predecessor expression
    # therefore allowed a NULL recipient snapshot on an active request even
    # though the worker correctly refused to dispatch it. Install the stronger
    # constraint as NOT VALID first so it fences new writes before legacy rows
    # are quarantined and validated.
    op.execute(
        "ALTER TABLE messaging.outbound_requests DROP CONSTRAINT ck_outbound_request_recipient_e164"
    )
    op.execute(
        r"""
        ALTER TABLE messaging.outbound_requests
        ADD CONSTRAINT ck_outbound_request_recipient_e164
        CHECK (
          (recipient_address IS NOT NULL
           AND recipient_address ~ '^\+[1-9][0-9]{7,14}$')
          OR
          (recipient_address IS NULL
           AND status IN ('sent', 'delivered', 'read', 'failed'))
        ) NOT VALID
        """
    )

    op.execute(
        """
        INSERT INTO audit.records(
          tenant_id, actor_service, action, target_type, target_id, metadata
        )
        SELECT request.tenant_id, 'schema_migration',
               'whatsapp.outbound.missing_binding_quarantined',
               'messaging.outbound_request', request.id,
               jsonb_build_object(
                 'previousStatus', request.status,
                 'reasonCode', 'legacy_recipient_binding_unavailable'
               )
        FROM messaging.outbound_requests request
        WHERE request.recipient_address IS NULL
          AND request.status IN ('queued', 'sending')
        """
    )
    op.execute(
        """
        UPDATE messaging.messages message
        SET status='failed', updated_at=CURRENT_TIMESTAMP
        FROM messaging.outbound_requests request
        WHERE request.message_id=message.id
          AND request.tenant_id=message.tenant_id
          AND request.recipient_address IS NULL
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
          AND request.recipient_address IS NULL
          AND request.status IN ('queued', 'sending')
          AND job.status IN ('queued', 'running', 'retry')
        """
    )
    op.execute(
        """
        UPDATE messaging.outbound_requests
        SET status='failed', completed_at=CURRENT_TIMESTAMP,
            last_error_code='legacy_recipient_binding_unavailable',
            updated_at=CURRENT_TIMESTAMP
        WHERE recipient_address IS NULL
          AND status IN ('queued', 'sending')
        """
    )
    op.execute(
        "ALTER TABLE messaging.outbound_requests "
        "VALIDATE CONSTRAINT ck_outbound_request_recipient_e164"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE messaging.outbound_requests DROP CONSTRAINT ck_outbound_request_recipient_e164"
    )
    op.execute(
        r"""
        ALTER TABLE messaging.outbound_requests
        ADD CONSTRAINT ck_outbound_request_recipient_e164
        CHECK (
          recipient_address ~ '^\+[1-9][0-9]{7,14}$'
          OR
          (recipient_address IS NULL
           AND status IN ('sent', 'delivered', 'read', 'failed'))
        )
        """
    )
