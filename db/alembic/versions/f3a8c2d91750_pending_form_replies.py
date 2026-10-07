"""Keep pending forms conversational and verify reuse of an issued link."""

# ruff: noqa: E501 -- keep reviewed PostgreSQL predicates intact.

from alembic import op

revision = "f3a8c2d91750"
down_revision = "f2c7a9d41860"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Preserve the predecessor's owned-job, actor, channel, consent and sender
    # admission. Reuse its locked caller's eligible intake before creating one.
    op.execute("""
      DO $patch$ DECLARE body text; needle text := 'IF EXISTS(SELECT 1 FROM service.intake_drafts WHERE tenant_id=v_tenant';
      BEGIN
        SELECT pg_get_functiondef('service.start_whatsapp_digital_intake(uuid,text,uuid,text)'::regprocedure) INTO body;
        IF strpos(body,needle)=0 THEN RAISE EXCEPTION 'Unexpected form admission predecessor'; END IF;
        body:=replace(body,needle,$replacement$
        SELECT intake.id INTO v_intake FROM service.intake_drafts intake
        WHERE intake.tenant_id=v_tenant AND intake.reporting_contact_id=v_contact
          AND (intake.conversation_id=p_conversation OR intake.conversation_id IS NULL)
          AND intake.status IN ('collecting','awaiting_confirmation')
          AND intake.workflow_policy#>>'{whatsappFollowUp,mode}'='form'
          AND ((intake.source_session_id IS NOT NULL
            AND nullif(btrim(intake.collected_fields->>'customerName'),'') IS NOT NULL
            AND nullif(btrim(intake.collected_fields->>'faultDescription'),'') IS NOT NULL
            AND EXISTS(SELECT 1 FROM messaging.inbound_message_origins origin
              WHERE origin.tenant_id=v_tenant AND origin.message_id=p_message
                AND service.verified_followup_recipient(intake.id,p_conversation,origin.contact_identity_id,v_phone)))
            OR (intake.source_session_id IS NULL AND EXISTS(SELECT 1 FROM service.whatsapp_form_sources source
              JOIN messaging.inbound_message_origins origin ON origin.tenant_id=source.tenant_id AND origin.message_id=source.trigger_message_id
              WHERE source.tenant_id=v_tenant AND source.intake_id=intake.id AND source.conversation_id=p_conversation
                AND origin.sender_address=v_phone)))
        ORDER BY intake.created_at DESC,intake.id DESC LIMIT 1 FOR UPDATE OF intake;
        IF FOUND THEN
          UPDATE service.intake_drafts SET followup_status='requested',followup_error_safe=NULL,
            conversation_id=p_conversation,updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=v_intake;
          RETURN v_intake;
        END IF;
        IF EXISTS(SELECT 1 FROM service.intake_drafts WHERE tenant_id=v_tenant$replacement$);
        -- An unfinished call draft for which no follow-up was ever requested
        -- must not block a new, independently authorized WhatsApp enquiry.
        body:=replace(body,$old$AND status IN ('collecting','awaiting_confirmation')
          AND workflow_policy$old$,$new$AND status IN ('collecting','awaiting_confirmation')
          AND followup_status<>'not_requested'
          AND workflow_policy$new$);
        EXECUTE body;
      END $patch$;
    """)
    op.execute("""
      CREATE FUNCTION service.reusable_whatsapp_form_receipt(
        p_intake uuid,p_conversation uuid,p_trigger uuid,p_outbound uuid,
        p_hash text,p_url text) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT coalesce(service.whatsapp_digital_form_available(),false) AND EXISTS(
          SELECT 1 FROM service.intake_drafts intake
          JOIN service.digital_intake_forms form ON form.tenant_id=intake.tenant_id AND form.intake_id=intake.id
          JOIN messaging.conversations conversation ON conversation.tenant_id=intake.tenant_id
            AND conversation.id=p_conversation AND conversation.contact_id=intake.reporting_contact_id
          JOIN messaging.channels channel ON channel.tenant_id=conversation.tenant_id AND channel.id=conversation.channel_id
          JOIN crm.contacts contact ON contact.tenant_id=conversation.tenant_id AND contact.id=conversation.contact_id
          JOIN messaging.messages trigger ON trigger.tenant_id=conversation.tenant_id
            AND trigger.conversation_id=conversation.id AND trigger.id=p_trigger
          JOIN messaging.inbound_message_origins origin ON origin.tenant_id=trigger.tenant_id AND origin.message_id=trigger.id
          JOIN crm.contact_channel_identities identity ON identity.tenant_id=origin.tenant_id
            AND identity.id=origin.contact_identity_id AND identity.contact_id=conversation.contact_id
            AND identity.normalized_value=origin.sender_address AND identity.channel='whatsapp'
            AND identity.validation_status='valid'
          JOIN messaging.messages original ON original.tenant_id=intake.tenant_id AND original.id=intake.followup_message_id
          WHERE intake.tenant_id=platform.current_tenant_id() AND intake.id=p_intake
            AND intake.conversation_id=conversation.id AND intake.followup_status='admitted'
            AND intake.status IN ('collecting','awaiting_confirmation')
            AND intake.workflow_policy#>>'{whatsappFollowUp,mode}'='form'
            AND form.token_hash=p_hash AND form.submitted_at IS NULL AND form.expires_at>clock_timestamp()
            AND conversation.ownership_mode='ai' AND conversation.status='open' AND conversation.removed_from_inbox_at IS NULL
            AND conversation.customer_service_window_expires_at>clock_timestamp()
            AND platform.messaging_ai_actor_authorized(conversation.ai_enabled_by_user_id)
            AND EXISTS(SELECT 1 FROM agents.agent_profile_versions agent WHERE agent.tenant_id=intake.tenant_id
              AND agent.id=conversation.ai_agent_profile_version_id AND agent.validation_status='valid'
              AND agent.published_at IS NOT NULL AND agent.tool_permissions ? 'service.intake')
            AND channel.status='active' AND channel.kind='whatsapp' AND channel.provider IN ('meta','simulator')
            AND contact.whatsapp_consent='granted' AND contact.whatsapp_opted_out_at IS NULL
            AND trigger.direction='inbound' AND trigger.sender_type='contact' AND trigger.status='received'
            AND original.conversation_id=conversation.id AND original.direction='outbound'
            AND (strpos(coalesce(original.content_text,''),p_url)>0
              OR strpos(coalesce(original.structured_content::text,''),p_url)>0)
            AND ((intake.source_session_id IS NOT NULL AND service.verified_followup_recipient(
              intake.id,conversation.id,identity.id,origin.sender_address))
              OR (intake.source_session_id IS NULL AND EXISTS(
                SELECT 1 FROM service.whatsapp_form_sources source
                JOIN messaging.inbound_message_origins first_origin ON first_origin.tenant_id=source.tenant_id
                  AND first_origin.message_id=source.trigger_message_id
                WHERE source.tenant_id=intake.tenant_id AND source.intake_id=intake.id
                  AND source.conversation_id=conversation.id AND first_origin.sender_address=origin.sender_address)))
            AND (p_outbound IS NULL OR EXISTS(SELECT 1 FROM messaging.messages outbound
              WHERE outbound.tenant_id=intake.tenant_id AND outbound.id=p_outbound
                AND outbound.conversation_id=conversation.id AND outbound.direction='outbound'
                AND outbound.sender_type='agent'
                AND outbound.provider_payload#>>'{aiGrounding,triggerMessageId}'=p_trigger::text)))
      $$;
    """)
    op.execute(
        "REVOKE ALL ON FUNCTION service.reusable_whatsapp_form_receipt(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION service.reusable_whatsapp_form_receipt(uuid,uuid,uuid,uuid,text,text) TO platform_messaging"
    )


def downgrade() -> None:
    # Runtime rollback keeps valid forms and their verification available.
    pass
