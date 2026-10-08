"""Narrow opening-menu exception for a verified consented voice form follow-up."""

# ruff: noqa: E501, S608 -- literal SQL patch fragments, never request data
import importlib

from alembic import op

revision = "fb26e8fd9756"
down_revision = "fa15d7ec8645"
branch_labels = None
depends_on = None
patch = importlib.import_module("db.alembic.versions.fa15d7ec8645_form_delivery_policy_v2").patch
SIGNATURE = "platform.opening_menu_business_job_allowed(uuid,text,uuid)"
OLD = "IF j.job_type='whatsapp.ai.call' AND j.reference_type='conversation' THEN"
NEW = (
    """IF j.job_type='field_service.intake_followup' AND j.reference_type='intake_draft'
        AND service.consented_voice_form_job(j.reference_id) THEN RETURN true; END IF;
      IF j.job_type='whatsapp.outbound.send' AND EXISTS(
        SELECT 1 FROM messaging.outbound_requests request JOIN service.intake_drafts draft
          ON draft.tenant_id=request.tenant_id AND draft.followup_message_id=request.message_id
        JOIN messaging.messages message ON message.tenant_id=request.tenant_id AND message.id=request.message_id
        WHERE request.tenant_id=j.tenant_id AND request.id=j.reference_id AND message.sender_type='system'
          AND service.consented_voice_form_job(draft.id)
          AND service.verified_followup_recipient(draft.id,request.conversation_id,request.recipient_identity_id,request.recipient_address)
          AND (request.message_kind='text' OR platform.whatsapp_template_request_allowed(request))
      ) THEN RETURN true; END IF;
      """
    + OLD
)


def upgrade() -> None:
    op.execute("""CREATE FUNCTION service.consented_voice_form_job(p_intake uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT EXISTS(SELECT 1 FROM service.intake_drafts draft
          JOIN public.sessions session ON session.tenant_id=draft.tenant_id AND session.session_id=draft.source_session_id
          JOIN crm.contacts contact ON contact.tenant_id=draft.tenant_id AND contact.id=draft.reporting_contact_id AND contact.id=session.contact_id
          JOIN crm.contact_channel_identities caller ON caller.tenant_id=draft.tenant_id
            AND caller.id=service.voice_session_caller_identity(draft.tenant_id,session.session_id)
          WHERE draft.tenant_id=platform.current_tenant_id() AND draft.id=p_intake
            AND platform.current_tenant_active() AND service.field_service_enabled()
            AND platform.current_tenant_feature_enabled('whatsapp')
            AND draft.status IN ('collecting','awaiting_confirmation') AND draft.followup_closed_at IS NULL
            AND draft.followup_status IN ('queued','requested','admitted','failed')
            AND session.status IN ('started','ended','failed')
            AND draft.workflow_policy#>>'{whatsappFollowUp,mode}'='form'
            AND draft.workflow_policy#>>'{whatsappFollowUp,enabled}'='true'
            AND draft.workflow_policy#>>'{whatsappFollowUp,trigger}'='intake_saved'
            AND nullif(btrim(draft.collected_fields->>'customerName'),'') IS NOT NULL
            AND nullif(btrim(draft.collected_fields->>'faultDescription'),'') IS NOT NULL
            AND contact.whatsapp_consent='granted' AND contact.whatsapp_opted_out_at IS NULL AND contact.lifecycle_status='active'
            AND NOT EXISTS(SELECT 1 FROM public.voice_session_controls control WHERE control.tenant_id=draft.tenant_id
              AND control.session_id=session.session_id AND control.desired_mode<>'ai')
            AND (service.whatsapp_form_template_configuration() IS NOT NULL OR EXISTS(
              SELECT 1 FROM messaging.conversations conversation
              JOIN messaging.channels channel ON channel.tenant_id=conversation.tenant_id AND channel.id=conversation.channel_id
              WHERE conversation.tenant_id=draft.tenant_id AND conversation.contact_id=contact.id
                AND conversation.removed_from_inbox_at IS NULL AND channel.status='active' AND channel.kind='whatsapp'
                AND conversation.customer_service_window_expires_at>clock_timestamp()
                AND EXISTS(SELECT 1 FROM messaging.messages message
                  JOIN messaging.inbound_message_origins origin ON origin.tenant_id=message.tenant_id AND origin.message_id=message.id
                  JOIN crm.contact_channel_identities identity ON identity.tenant_id=origin.tenant_id AND identity.id=origin.contact_identity_id
                  WHERE message.tenant_id=draft.tenant_id AND message.conversation_id=conversation.id
                    AND identity.normalized_value=caller.normalized_value AND identity.validation_status NOT IN ('invalid','revoked')))))
      $$""")
    op.execute("REVOKE ALL ON FUNCTION service.consented_voice_form_job(uuid) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION service.consented_voice_form_job(uuid) TO platform_messaging,platform_migrator"
    )
    patch(SIGNATURE, OLD, NEW)


def downgrade() -> None:
    patch(SIGNATURE, NEW, OLD)
    op.execute("DROP FUNCTION service.consented_voice_form_job(uuid)")
