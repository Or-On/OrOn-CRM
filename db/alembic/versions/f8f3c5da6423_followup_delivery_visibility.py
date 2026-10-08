"""Fence delivery attempts and expose separate form-open observations."""

# ruff: noqa: E501
from alembic import op

revision = "f8f3c5da6423"
down_revision = "f7e2b4c95312"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE service.intake_drafts ADD COLUMN followup_attempt integer NOT NULL DEFAULT 0 CHECK(followup_attempt BETWEEN 0 AND 3), ADD COLUMN followup_closed_at timestamptz"
    )
    op.execute("ALTER TABLE service.digital_intake_forms ADD COLUMN first_opened_at timestamptz")
    op.execute(
        "GRANT SELECT(tenant_id,intake_id,expires_at,submitted_at,first_opened_at) ON service.digital_intake_forms TO platform_web"
    )
    op.execute("""CREATE FUNCTION service.mark_digital_form_opened(p_hash text) RETURNS void
      LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        UPDATE service.digital_intake_forms SET first_opened_at=coalesce(first_opened_at,clock_timestamp())
        WHERE tenant_id=platform.current_tenant_id() AND token_hash=p_hash
          AND service.read_digital_intake_form(p_hash) IS NOT NULL
      $$""")
    op.execute("REVOKE ALL ON FUNCTION service.mark_digital_form_opened(text) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION service.mark_digital_form_opened(text) TO platform_web")
    op.execute("""CREATE FUNCTION service.allocate_followup_attempt(p_intake uuid) RETURNS integer
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE draft service.intake_drafts%ROWTYPE; prior messaging.outbound_requests%ROWTYPE;
      BEGIN
        SELECT * INTO draft FROM service.intake_drafts WHERE tenant_id=platform.current_tenant_id() AND id=p_intake FOR UPDATE;
        IF NOT FOUND OR draft.followup_closed_at IS NOT NULL OR draft.status NOT IN ('collecting','awaiting_confirmation') THEN RETURN 0; END IF;
        IF draft.followup_message_id IS NOT NULL THEN
          SELECT * INTO prior FROM messaging.outbound_requests WHERE tenant_id=draft.tenant_id AND message_id=draft.followup_message_id FOR UPDATE;
          IF NOT FOUND OR prior.status='sending' OR prior.last_error_code='delivery_outcome_unknown' THEN
            PERFORM service.record_intake_followup(p_intake,'failed',NULL,'delivery_outcome_unknown'); RETURN 0;
          END IF;
          IF prior.status<>'failed' OR prior.provider_message_id IS NOT NULL THEN RETURN 0; END IF;
        ELSIF draft.followup_status='admitted' THEN
          PERFORM service.record_intake_followup(p_intake,'failed',NULL,'delivery_outcome_unknown'); RETURN 0;
        END IF;
        IF draft.followup_attempt>=3 THEN
          PERFORM service.record_intake_followup(p_intake,'failed',NULL,'delivery_attempts_exhausted'); RETURN 0;
        END IF;
        UPDATE service.intake_drafts SET followup_attempt=followup_attempt+1,followup_status='requested',followup_message_id=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=draft.tenant_id AND id=draft.id RETURNING followup_attempt INTO draft.followup_attempt;
        RETURN draft.followup_attempt;
      END $$""")
    op.execute("REVOKE ALL ON FUNCTION service.allocate_followup_attempt(uuid) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION service.allocate_followup_attempt(uuid) TO platform_messaging"
    )
    op.execute("""CREATE FUNCTION service.sync_terminal_followup_delivery() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
        IF NEW.status='failed' THEN
          UPDATE service.intake_drafts SET followup_status='failed',
            followup_error_safe=CASE WHEN NEW.last_error_code='delivery_outcome_unknown' THEN 'delivery_outcome_unknown' ELSE 'outbound_delivery_failed' END,
            updated_at=clock_timestamp() WHERE tenant_id=NEW.tenant_id AND followup_message_id=NEW.message_id AND followup_closed_at IS NULL;
        END IF;
        RETURN NEW;
      END $$""")
    op.execute("REVOKE ALL ON FUNCTION service.sync_terminal_followup_delivery() FROM PUBLIC")
    op.execute(
        "CREATE TRIGGER terminal_followup_delivery AFTER UPDATE OF status ON messaging.outbound_requests FOR EACH ROW EXECUTE FUNCTION service.sync_terminal_followup_delivery()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER terminal_followup_delivery ON messaging.outbound_requests")
    op.execute("DROP FUNCTION service.sync_terminal_followup_delivery()")
    op.execute("DROP FUNCTION service.allocate_followup_attempt(uuid)")
    op.execute("DROP FUNCTION service.mark_digital_form_opened(text)")
    op.execute(
        "REVOKE SELECT(tenant_id,intake_id,expires_at,submitted_at,first_opened_at) ON service.digital_intake_forms FROM platform_web"
    )
    op.execute("ALTER TABLE service.digital_intake_forms DROP COLUMN first_opened_at")
    op.execute(
        "ALTER TABLE service.intake_drafts DROP COLUMN followup_attempt, DROP COLUMN followup_closed_at"
    )
