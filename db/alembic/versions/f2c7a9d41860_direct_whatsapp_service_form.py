"""Issue the same customer-submitted form from a verified WhatsApp interaction.

No synthetic voice session, no case before submission, no new template grant.
The source message, conversation and public origin are retained as delivery proof.
"""

# ruff: noqa: E501 -- reviewed PostgreSQL definitions
from alembic import op

revision = "f2c7a9d41860"
down_revision = "e6a91c4f208b"
branch_labels = None
depends_on = None


def execute(script: str) -> None:
    pending = ""
    for index, part in enumerate(script.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
            continue
        pieces = part.split(";")
        pending += pieces[0]
        for piece in pieces[1:]:
            if pending.strip():
                op.execute(pending.replace(":", r"\:"))
            pending = piece
    if pending.strip():
        op.execute(pending.replace(":", r"\:"))


def patch(signature: str, before: str, after: str) -> None:
    # Runs identically in Alembic online mode and its reviewed offline SQL.
    signature, before, after = (value.replace("'", "''") for value in (signature, before, after))
    op.execute(
        f"""DO $patch$
      DECLARE definition text:=pg_get_functiondef(to_regprocedure('{signature}'));
        needle text:='{before}'; replacement text:='{after}';
      BEGIN
        IF definition IS NULL OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
          RAISE EXCEPTION 'Unexpected digital-form migration predecessor'; END IF;
        EXECUTE replace(definition,needle,replacement);
      END $patch$""".replace(":", r"\:")
    )


SOURCE_PROOF = """EXISTS(SELECT 1 FROM service.whatsapp_form_sources source
  WHERE source.tenant_id=v_tenant AND source.intake_id=v_intake.id
    AND source.conversation_id=v_intake.conversation_id)"""


def upgrade() -> None:
    execute(r"""
      CREATE TABLE service.whatsapp_form_sources (
        tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
        intake_id uuid NOT NULL,
        conversation_id uuid NOT NULL,
        trigger_message_id uuid NOT NULL,
        public_origin text NOT NULL CHECK(public_origin ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'),
        PRIMARY KEY(tenant_id,intake_id),
        UNIQUE(tenant_id,trigger_message_id),
        FOREIGN KEY(tenant_id,intake_id) REFERENCES service.intake_drafts(tenant_id,id) ON DELETE CASCADE,
        FOREIGN KEY(tenant_id,conversation_id) REFERENCES messaging.conversations(tenant_id,id),
        FOREIGN KEY(tenant_id,trigger_message_id) REFERENCES messaging.messages(tenant_id,id)
      );
      ALTER TABLE service.whatsapp_form_sources ENABLE ROW LEVEL SECURITY;
      ALTER TABLE service.whatsapp_form_sources FORCE ROW LEVEL SECURITY;
      CREATE POLICY whatsapp_form_sources_tenant ON service.whatsapp_form_sources
        USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
      GRANT SELECT,INSERT,UPDATE,DELETE ON service.whatsapp_form_sources TO platform_migrator;

      CREATE FUNCTION service.whatsapp_digital_form_available() RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT platform.current_tenant_active() AND service.field_service_enabled()
          AND platform.current_tenant_feature_enabled('field_service')
          AND platform.current_tenant_feature_enabled('tickets')
          AND platform.current_tenant_feature_enabled('whatsapp')
          AND EXISTS(SELECT 1 FROM service.tenant_configuration
            WHERE tenant_id=platform.current_tenant_id() AND enabled AND whatsapp_intake_enabled)
          AND service.current_workflow_policy()#>>'{whatsappFollowUp,enabled}'='true'
          AND service.current_workflow_policy()#>>'{whatsappFollowUp,mode}'='form'
      $$;

      CREATE FUNCTION service.start_whatsapp_digital_intake(p_job uuid,p_worker text,p_claim uuid,p_origin text) RETURNS uuid
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_contact uuid; v_name text; v_phone text; v_intake uuid; p_conversation uuid; p_message uuid; p_actor uuid;
      BEGIN
        PERFORM platform.authorize_machine_tool(p_job,p_worker,p_claim,'service.intake');
        SELECT job.reference_id,(job.payload->>'triggerMessageId')::uuid,conversation.ai_enabled_by_user_id
          INTO p_conversation,p_message,p_actor FROM ops.jobs job
          JOIN messaging.conversations conversation ON conversation.tenant_id=job.tenant_id AND conversation.id=job.reference_id
          WHERE job.tenant_id=v_tenant AND job.id=p_job AND job.job_type='whatsapp.ai.reply'
            AND job.status='running' AND job.locked_by=p_worker AND job.claim_token=p_claim
            AND job.lease_expires_at>clock_timestamp();
        IF NOT FOUND THEN RAISE EXCEPTION 'owned AI reply required' USING ERRCODE='42501'; END IF;
        IF NOT coalesce(service.whatsapp_digital_form_available(),false)
          OR NOT platform.messaging_ai_actor_authorized(p_actor) THEN
          RAISE EXCEPTION 'WhatsApp service form unavailable' USING ERRCODE='42501'; END IF;
        SELECT conversation.contact_id,contact.name,origin.sender_address INTO v_contact,v_name,v_phone
        FROM messaging.conversations conversation
        JOIN messaging.channels channel ON channel.tenant_id=conversation.tenant_id AND channel.id=conversation.channel_id
        JOIN crm.contacts contact ON contact.tenant_id=conversation.tenant_id AND contact.id=conversation.contact_id
        JOIN messaging.messages message ON message.tenant_id=conversation.tenant_id AND message.conversation_id=conversation.id
        JOIN messaging.inbound_message_origins origin ON origin.tenant_id=message.tenant_id AND origin.message_id=message.id
        JOIN crm.contact_channel_identities identity ON identity.tenant_id=origin.tenant_id
          AND identity.id=origin.contact_identity_id AND identity.contact_id=conversation.contact_id
          AND identity.normalized_value=origin.sender_address AND identity.channel='whatsapp'
          AND identity.validation_status='valid'
        WHERE conversation.tenant_id=v_tenant AND conversation.id=p_conversation
          AND EXISTS(SELECT 1 FROM agents.agent_profile_versions agent
            WHERE agent.tenant_id=v_tenant AND agent.id=conversation.ai_agent_profile_version_id
              AND agent.published_at IS NOT NULL AND agent.validation_status='valid'
              AND agent.tool_permissions @> '["service.intake"]'::jsonb)
          AND conversation.ownership_mode='ai' AND conversation.ai_enabled_by_user_id=p_actor
          AND conversation.removed_from_inbox_at IS NULL AND conversation.status='open'
          AND conversation.customer_service_window_expires_at>clock_timestamp()
          AND channel.kind='whatsapp' AND channel.provider IN ('meta','simulator') AND channel.status='active'
          AND message.id=p_message AND message.direction='inbound' AND message.sender_type='contact'
          AND message.status='received' AND message.content_type<>'event'
          AND contact.whatsapp_consent='granted' AND contact.whatsapp_opted_out_at IS NULL
        FOR UPDATE OF conversation;
        IF NOT FOUND THEN RAISE EXCEPTION 'verified WhatsApp interaction required' USING ERRCODE='42501'; END IF;
        -- One owned conversation is locked across creation, preventing two requests
        -- from making competing links. Do not replace an outstanding phone form.
        SELECT intake_id INTO v_intake FROM service.whatsapp_form_sources
          WHERE tenant_id=v_tenant AND trigger_message_id=p_message AND conversation_id=p_conversation;
        IF FOUND THEN RETURN v_intake; END IF;
        IF EXISTS(SELECT 1 FROM service.intake_drafts WHERE tenant_id=v_tenant
          AND (conversation_id=p_conversation OR reporting_contact_id=v_contact OR customer_contact_id=v_contact)
          AND status IN ('collecting','awaiting_confirmation')
          AND workflow_policy#>>'{whatsappFollowUp,mode}'='form') THEN
          RAISE EXCEPTION 'an outstanding service form already exists' USING ERRCODE='42501'; END IF;
        INSERT INTO service.intake_drafts(tenant_id,conversation_id,reporting_contact_id,customer_contact_id,
          customer_resolution_status,correlation_key,collected_fields,followup_status,last_message_at)
        VALUES(v_tenant,p_conversation,v_contact,v_contact,'reporting_contact','whatsapp-form:'||p_message::text,
          jsonb_build_object('customerPhone',v_phone) || CASE WHEN v_name ~ '^\+?[0-9 ()-]{7,}$' THEN '{}'::jsonb ELSE jsonb_build_object('customerName',left(v_name,160)) END,
          'requested',clock_timestamp()) RETURNING id INTO v_intake;
        INSERT INTO service.whatsapp_form_sources(tenant_id,intake_id,conversation_id,trigger_message_id,public_origin)
          VALUES(v_tenant,v_intake,p_conversation,p_message,p_origin);
        INSERT INTO service.intake_messages(tenant_id,intake_draft_id,message_id) VALUES(v_tenant,v_intake,p_message);
        INSERT INTO audit.records(tenant_id,actor_user_id,actor_service,action,target_type,target_id,metadata)
          VALUES(v_tenant,p_actor,'messaging-worker','field_service.digital_form.requested','intake_draft',v_intake,
            jsonb_build_object('conversationId',p_conversation,'triggerMessageId',p_message));
        RETURN v_intake;
      END $$;

      CREATE FUNCTION service.whatsapp_digital_form_receipt(p_intake uuid,p_conversation uuid,p_trigger uuid,p_outbound uuid,p_hash text,p_origin text) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT coalesce(service.whatsapp_digital_form_available(),false) AND EXISTS(
          SELECT 1 FROM service.whatsapp_form_sources source
          JOIN service.intake_drafts intake ON intake.tenant_id=source.tenant_id AND intake.id=source.intake_id
          JOIN service.digital_intake_forms form ON form.tenant_id=source.tenant_id AND form.intake_id=source.intake_id
          JOIN messaging.messages message ON message.tenant_id=source.tenant_id AND message.id=intake.followup_message_id
          WHERE source.tenant_id=platform.current_tenant_id() AND source.intake_id=p_intake
            AND source.conversation_id=p_conversation AND source.trigger_message_id=p_trigger
            AND source.public_origin=p_origin AND intake.source_session_id IS NULL
            AND intake.followup_status='admitted' AND intake.followup_message_id=p_outbound
            AND message.conversation_id=p_conversation AND message.direction='outbound' AND message.sender_type='agent'
            AND form.token_hash=p_hash AND form.expires_at>clock_timestamp() AND form.submitted_at IS NULL
            AND intake.status IN ('collecting','awaiting_confirmation'))
      $$;
      REVOKE ALL ON FUNCTION service.whatsapp_digital_form_available(),service.start_whatsapp_digital_intake(uuid,text,uuid,text),
        service.whatsapp_digital_form_receipt(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION service.whatsapp_digital_form_available(),service.start_whatsapp_digital_intake(uuid,text,uuid,text),
        service.whatsapp_digital_form_receipt(uuid,uuid,uuid,uuid,text,text) TO platform_messaging;
    """)
    patch(
        "service.issue_digital_intake_form(uuid,text)",
        "OR v_intake.source_session_id IS NULL OR v_intake.workflow_policy",
        "OR (v_intake.source_session_id IS NULL AND NOT "
        + SOURCE_PROOF
        + ") OR v_intake.workflow_policy",
    )
    patch(
        "service.issue_digital_intake_form(uuid,text)",
        "OR nullif(btrim(v_intake.collected_fields->>'customerName'),'') IS NULL\n            OR nullif(btrim(v_intake.collected_fields->>'faultDescription'),'') IS NULL",
        "OR (v_intake.source_session_id IS NOT NULL AND (nullif(btrim(v_intake.collected_fields->>'customerName'),'') IS NULL OR nullif(btrim(v_intake.collected_fields->>'faultDescription'),'') IS NULL))",
    )
    patch(
        "service.open_form_intake_case(uuid)",
        "OR v_intake.source_session_id IS NULL OR v_intake.followup_status",
        "OR (v_intake.source_session_id IS NULL AND NOT "
        + SOURCE_PROOF
        + ") OR v_intake.followup_status",
    )
    patch(
        "service.open_form_intake_case(uuid)",
        "v_policy:=v_intake.workflow_policy; v_fields:=v_intake.collected_fields;",
        "v_policy:=v_intake.workflow_policy; v_fields:=v_intake.collected_fields; IF nullif(v_fields->>'storeName','') IS NULL THEN v_fields:=v_fields||jsonb_build_object('storeName',left(v_fields->>'serviceAddress',160)); END IF;",
    )
    patch(
        "service.open_form_intake_case(uuid)",
        "v_fields->>'serialNumber','voice',",
        "v_fields->>'serialNumber',CASE WHEN v_intake.source_session_id IS NULL THEN 'whatsapp' ELSE 'voice' END,",
    )
    patch(
        "service.open_form_intake_case(uuid)",
        "INSERT INTO service.case_calls(tenant_id,case_id,session_id,relationship) VALUES(v_tenant,v_case,v_intake.source_session_id,'intake') ON CONFLICT DO NOTHING;",
        "IF v_intake.source_session_id IS NOT NULL THEN INSERT INTO service.case_calls(tenant_id,case_id,session_id,relationship) VALUES(v_tenant,v_case,v_intake.source_session_id,'intake') ON CONFLICT DO NOTHING; END IF;",
    )


def downgrade() -> None:
    # Issued bearer forms are customer commitments. A deploy can roll back the
    # app image while retaining this additive schema; discarding live forms is unsafe.
    raise RuntimeError("Retain issued WhatsApp forms; application rollback is supported")
