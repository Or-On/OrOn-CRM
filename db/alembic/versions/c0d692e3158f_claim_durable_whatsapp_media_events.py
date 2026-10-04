"""Preserve supported media and non-action events in the durable inbox.

Revision ID: c0d692e3158f
Revises: b9c581d2047e
"""

from alembic import op

revision = "c0d692e3158f"
down_revision = "b9c581d2047e"
branch_labels = None
depends_on = None


def _claim(expanded: bool) -> None:
    extra = (
        ", 'whatsapp.message.audio','whatsapp.message.video',"
        "'whatsapp.message.interactive','whatsapp.message.event'"
        if expanded
        else ""
    )
    op.execute(f"""
      CREATE OR REPLACE FUNCTION ops.claim_inbound_events(
        p_worker_id text,p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT 300)
      RETURNS SETOF ops.inbound_events LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog AS $$
        WITH candidates AS (
          SELECT id FROM ops.inbound_events WHERE attempts<max_attempts
            AND provider='meta' AND tenant_id IS NOT NULL
            AND event_type IN ('whatsapp.message.text','whatsapp.message.image',
              'whatsapp.message.document','whatsapp.message.location','whatsapp.message.status'{extra})
            AND ((status IN ('received','failed') AND available_at<=CURRENT_TIMESTAMP)
              OR (status='processing' AND locked_at<CURRENT_TIMESTAMP
                - make_interval(secs=>GREATEST(1,p_lease_seconds))))
          ORDER BY available_at,received_at,id FOR UPDATE SKIP LOCKED
          LIMIT LEAST(GREATEST(p_limit,1),100)
        ) UPDATE ops.inbound_events event SET status='processing',attempts=event.attempts+1,
          locked_at=CURRENT_TIMESTAMP,locked_by=p_worker_id FROM candidates
          WHERE event.id=candidates.id RETURNING event.*
      $$
    """)  # noqa: S608 - closed migration constants only


def _flags(audio: bool) -> None:
    extra = ", 'audio_transcription'" if audio else ""
    op.execute(
        "ALTER TABLE platform.tenant_remediation_flags DROP CONSTRAINT "
        "tenant_remediation_flags_flag_key_check"
    )
    op.execute(f"""
      ALTER TABLE platform.tenant_remediation_flags
      ADD CONSTRAINT tenant_remediation_flags_flag_key_check
      CHECK(flag_key IN ('no_silence','queue_priority','exclude_ai_memory','typing',
        'session_memory','retrieval_fts','handoff_resume','debounce'{extra}))
    """)  # noqa: S608 - closed migration constants only


def upgrade() -> None:
    _claim(True)
    _flags(True)


def downgrade() -> None:
    # Do not silently destroy rollout configuration to make a rollback pass.
    op.execute("""
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM platform.tenant_remediation_flags
        WHERE flag_key='audio_transcription')
        THEN RAISE EXCEPTION
          'Review and remove audio_transcription rollout configuration before downgrade';
      END IF; END $$
    """)
    _flags(False)
    _claim(False)
