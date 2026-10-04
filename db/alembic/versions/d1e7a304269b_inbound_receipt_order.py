"""Deterministic inbound receipt order and exhausted-event operator evidence."""

from alembic import op

revision = "d1e7a304269b"
down_revision = "c0d692e3158f"
branch_labels = None
depends_on = None


def _claim(receipt_order: bool):
    order = "receipt_sequence" if receipt_order else "id"
    op.execute(f"""CREATE OR REPLACE FUNCTION ops.claim_inbound_events(
        p_worker_id text,p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT 300)
      RETURNS SETOF ops.inbound_events LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog AS $$
        WITH candidates AS (
          SELECT id FROM ops.inbound_events WHERE attempts<max_attempts
            AND provider='meta' AND tenant_id IS NOT NULL
            AND event_type IN ('whatsapp.message.text','whatsapp.message.image',
              'whatsapp.message.document','whatsapp.message.location','whatsapp.message.status',
              'whatsapp.message.audio','whatsapp.message.video',
              'whatsapp.message.interactive','whatsapp.message.event')
            AND ((status IN ('received','failed') AND available_at<=CURRENT_TIMESTAMP)
              OR (status='processing' AND locked_at<CURRENT_TIMESTAMP
                - make_interval(secs=>GREATEST(1,p_lease_seconds))))
          ORDER BY available_at,received_at,{order} FOR UPDATE SKIP LOCKED
          LIMIT LEAST(GREATEST(p_limit,1),100)
        ) UPDATE ops.inbound_events event SET status='processing',attempts=event.attempts+1,
          locked_at=CURRENT_TIMESTAMP,locked_by=p_worker_id FROM candidates
          WHERE event.id=candidates.id RETURNING event.*
      $$""")  # noqa: S608 - closed migration constants only


def upgrade():
    op.execute(
        "ALTER TABLE ops.inbound_events ADD COLUMN receipt_sequence bigint "
        "GENERATED ALWAYS AS IDENTITY"
    )
    op.execute(
        "CREATE UNIQUE INDEX inbound_receipt_sequence ON ops.inbound_events(receipt_sequence)"
    )
    _claim(True)
    op.execute("""CREATE TABLE ops.inbound_failure_alerts(
      event_id uuid PRIMARY KEY REFERENCES ops.inbound_events(id)
        ON DELETE RESTRICT,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id)
        ON DELETE RESTRICT,
      reason_code text NOT NULL CHECK(reason_code='inbound_attempts_exhausted'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      acknowledged_at timestamptz)""")
    op.execute("ALTER TABLE ops.inbound_failure_alerts ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE ops.inbound_failure_alerts FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY inbound_failure_isolation ON ops.inbound_failure_alerts "
        "USING(tenant_id=platform.current_tenant_id())"
    )
    op.execute("GRANT SELECT ON ops.inbound_failure_alerts TO platform_web,platform_messaging")
    op.execute("""CREATE FUNCTION ops.surface_exhausted_inbound()
      RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE inserted integer;
      BEGIN
        INSERT INTO ops.inbound_failure_alerts(event_id,tenant_id,reason_code)
          SELECT id,tenant_id,'inbound_attempts_exhausted' FROM ops.inbound_events
          WHERE tenant_id=platform.current_tenant_id() AND provider='meta'
            AND status='failed' AND attempts>=max_attempts
          ON CONFLICT(event_id) DO NOTHING;
        GET DIAGNOSTICS inserted=ROW_COUNT; RETURN inserted;
      END $$""")
    op.execute("REVOKE ALL ON FUNCTION ops.surface_exhausted_inbound() FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION ops.surface_exhausted_inbound() TO platform_messaging")


def downgrade():
    _claim(False)
    op.execute("DROP FUNCTION ops.surface_exhausted_inbound()")
    op.execute("DROP TABLE ops.inbound_failure_alerts")
    op.execute("DROP INDEX ops.inbound_receipt_sequence")
    op.execute("ALTER TABLE ops.inbound_events DROP COLUMN receipt_sequence")
