"""Preserve uncertain delivery and scope form-open observations to one token."""

# ruff: noqa: E501, S608 -- static reviewed SQL fragments, no request input
from importlib import import_module

from alembic import op

revision = "a07b3d42ec91"
down_revision = "ff6a2c31db90"
branch_labels = None
depends_on = None

patch = import_module("db.alembic.versions.fa15d7ec8645_form_delivery_policy_v2").patch
REUSE = "service.reusable_whatsapp_form_receipt(uuid,uuid,uuid,uuid,text,text)"
START = "service.start_whatsapp_digital_intake(uuid,text,uuid,text)"
BEFORE_REUSE = "AND intake.conversation_id=conversation.id AND intake.followup_status='admitted'"
AFTER_REUSE = (
    BEFORE_REUSE
    + """
            AND intake.followup_closed_at IS NULL
            AND EXISTS(SELECT 1 FROM messaging.outbound_requests prior
              WHERE prior.tenant_id=intake.tenant_id AND prior.message_id=intake.followup_message_id
              AND ((prior.status IN ('sent','delivered','read') AND prior.provider_message_id IS NOT NULL)
                OR (p_outbound=prior.message_id AND prior.status IN ('queued','sending')))
              AND prior.last_error_code IS DISTINCT FROM 'delivery_outcome_unknown')"""
)
BEFORE_START = """IF FOUND THEN
          UPDATE service.intake_drafts SET followup_status='requested',followup_error_safe=NULL,"""
AFTER_START = """IF FOUND THEN
          IF EXISTS(SELECT 1 FROM service.intake_drafts draft
            LEFT JOIN messaging.outbound_requests prior ON prior.tenant_id=draft.tenant_id AND prior.message_id=draft.followup_message_id
            WHERE draft.id=v_intake AND draft.tenant_id=v_tenant AND (
              draft.followup_closed_at IS NOT NULL OR draft.followup_error_safe='delivery_outcome_unknown'
              OR prior.status IN ('queued','sending') OR prior.last_error_code='delivery_outcome_unknown'
              OR (draft.followup_status='admitted' AND prior.id IS NULL))) THEN
            RAISE EXCEPTION 'Previous form delivery requires reconciliation' USING ERRCODE='22023';
          END IF;
          UPDATE service.intake_drafts SET followup_status='requested',followup_error_safe=NULL,"""


def upgrade() -> None:
    patch(REUSE, BEFORE_REUSE, AFTER_REUSE)
    patch(START, BEFORE_START, AFTER_START)
    op.execute("""CREATE FUNCTION service.reset_form_open_observation() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
        IF NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN NEW.first_opened_at:=NULL; END IF;
        RETURN NEW;
      END $$""")
    op.execute("REVOKE ALL ON FUNCTION service.reset_form_open_observation() FROM PUBLIC")
    op.execute("""CREATE TRIGGER reset_form_open_observation BEFORE UPDATE OF token_hash ON service.digital_intake_forms
      FOR EACH ROW EXECUTE FUNCTION service.reset_form_open_observation()""")
    op.execute("""CREATE FUNCTION service.incomplete_intake_recipient(p_intake uuid) RETURNS text
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT identity.normalized_value FROM service.intake_drafts draft
        JOIN crm.contact_channel_identities identity ON identity.tenant_id=draft.tenant_id
          AND identity.contact_id=draft.reporting_contact_id
          AND identity.id=CASE WHEN draft.source_session_id IS NOT NULL
            THEN service.voice_session_caller_identity(draft.tenant_id,draft.source_session_id)
            ELSE (SELECT origin.contact_identity_id FROM service.whatsapp_form_sources source
              JOIN messaging.inbound_message_origins origin ON origin.tenant_id=source.tenant_id AND origin.message_id=source.trigger_message_id
              WHERE source.tenant_id=draft.tenant_id AND source.intake_id=draft.id AND source.conversation_id=draft.conversation_id) END
        WHERE draft.tenant_id=platform.current_tenant_id() AND draft.id=p_intake
          AND service.can_manage_incomplete_intake() AND identity.validation_status NOT IN ('invalid','revoked')
          AND identity.normalized_value ~ '^[+][1-9][0-9]{7,14}$'
      $$""")
    op.execute("REVOKE ALL ON FUNCTION service.incomplete_intake_recipient(uuid) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION service.incomplete_intake_recipient(uuid) TO platform_web"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION service.incomplete_intake_recipient(uuid)")
    op.execute("DROP TRIGGER reset_form_open_observation ON service.digital_intake_forms")
    op.execute("DROP FUNCTION service.reset_form_open_observation()")
    patch(START, AFTER_START, BEFORE_START)
    patch(REUSE, AFTER_REUSE, BEFORE_REUSE)
