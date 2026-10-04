"""Keep old workers from claiming Coexistence receipts they cannot interpret.

Revision ID: 9e43a5b02d81
Revises: 8d32f4a91c70
"""

from alembic import op

revision = "9e43a5b02d81"
down_revision = "8d32f4a91c70"
branch_labels = None
depends_on = None


def _claim(opt_in: bool) -> None:
    arguments = (
        "p_worker_id text,p_limit integer,p_lease_seconds integer,p_include_coexistence boolean"
        if opt_in
        else "p_worker_id text,p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT 300"
    )
    additional_types = (
        """OR (p_include_coexistence IS TRUE AND event_type IN (
          'whatsapp.coexistence.account_update','whatsapp.coexistence.history',
          'whatsapp.coexistence.smb_app_state_sync','whatsapp.coexistence.smb_message_echoes'))"""
        if opt_in
        else ""
    )
    # Both contracts retain identical ordering, SKIP LOCKED, lease recovery and
    # attempt/limit fences. The fourth argument has no default: old clients
    # cannot opt in through overload resolution.
    op.execute(f"""CREATE OR REPLACE FUNCTION ops.claim_inbound_events({arguments})
      RETURNS SETOF ops.inbound_events LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog AS $$
        WITH candidates AS (
          SELECT id FROM ops.inbound_events WHERE attempts<max_attempts
            AND provider='meta' AND tenant_id IS NOT NULL
            AND (event_type IN ('whatsapp.message.text','whatsapp.message.image',
              'whatsapp.message.document','whatsapp.message.location','whatsapp.message.status',
              'whatsapp.message.audio','whatsapp.message.video',
              'whatsapp.message.interactive','whatsapp.message.event') {additional_types})
            AND ((status IN ('received','failed') AND available_at<=CURRENT_TIMESTAMP)
              OR (status='processing' AND locked_at<CURRENT_TIMESTAMP
                - make_interval(secs=>GREATEST(1,p_lease_seconds))))
          ORDER BY available_at,received_at,receipt_sequence FOR UPDATE SKIP LOCKED
          LIMIT LEAST(GREATEST(p_limit,1),100)
        ) UPDATE ops.inbound_events event SET status='processing',attempts=event.attempts+1,
          locked_at=CURRENT_TIMESTAMP,locked_by=p_worker_id FROM candidates
          WHERE event.id=candidates.id RETURNING event.*
      $$""")  # noqa: S608 - closed migration constants only


def upgrade() -> None:
    _claim(False)
    _claim(True)
    signature = "ops.claim_inbound_events(text,integer,integer,boolean)"
    op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION {signature} TO platform_messaging")


def downgrade() -> None:
    # Preserve the safe legacy contract on application/schema rollback. Pending
    # new-format events remain durable until a capable worker returns.
    op.execute("DROP FUNCTION ops.claim_inbound_events(text,integer,integer,boolean)")
