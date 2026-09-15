"""claim every supported WhatsApp inbound event

Revision ID: 7d91e4a3c620
Revises: 4c8d2a7e9f10
Create Date: 2026-09-16 00:55:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "7d91e4a3c620"
down_revision: str | None = "4c8d2a7e9f10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SUPPORTED_WHATSAPP_EVENTS = (
    "whatsapp.message.text",
    "whatsapp.message.image",
    "whatsapp.message.document",
    "whatsapp.message.location",
    "whatsapp.message.status",
)


def _replace_claim_function(event_types: tuple[str, ...]) -> None:
    # The values are closed migration constants, never caller-controlled SQL.
    allowed = ",".join(f"'{event_type}'" for event_type in event_types)
    op.execute(f"""
      CREATE OR REPLACE FUNCTION ops.claim_inbound_events(
        p_worker_id text, p_limit integer DEFAULT 10,
        p_lease_seconds integer DEFAULT 300
      ) RETURNS SETOF ops.inbound_events
      LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
        WITH candidates AS (
          SELECT id
          FROM ops.inbound_events
          WHERE attempts < max_attempts
            AND provider = 'meta'
            AND tenant_id IS NOT NULL
            AND event_type IN ({allowed})
            AND (
              (status IN ('received','failed')
                AND available_at <= CURRENT_TIMESTAMP)
              OR (
                status = 'processing'
                AND locked_at < CURRENT_TIMESTAMP
                  - make_interval(secs => GREATEST(1,p_lease_seconds))
              )
            )
          ORDER BY available_at,received_at,id
          FOR UPDATE SKIP LOCKED
          LIMIT LEAST(GREATEST(p_limit,1),100)
        )
        UPDATE ops.inbound_events event
        SET status='processing',attempts=event.attempts+1,
            locked_at=CURRENT_TIMESTAMP,locked_by=p_worker_id
        FROM candidates
        WHERE event.id=candidates.id
        RETURNING event.*
      $$
    """)  # noqa: S608
    op.execute(
        "REVOKE ALL ON FUNCTION ops.claim_inbound_events(text, integer, integer) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "ops.claim_inbound_events(text, integer, integer) "
        "TO platform_worker, platform_messaging"
    )


def upgrade() -> None:
    _replace_claim_function(SUPPORTED_WHATSAPP_EVENTS)


def downgrade() -> None:
    _replace_claim_function(("whatsapp.message.text", "whatsapp.message.status"))
