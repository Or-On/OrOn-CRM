"""Allow one reviewed service-form template without enabling tenant templates.

The exception binds the tenant, channel, approved template and public origin.
Only a system follow-up to the verified caller can use it, with a live form
capability belonging to that exact intake. Normal template/menu policy stays
unchanged. Deployment supplies the reviewed binding; migrations enable none.
"""

# ruff: noqa: E501 -- reviewed PostgreSQL definitions
from alembic import op

revision = "e6a91c4f208b"
down_revision = "d7b80a4c913e"
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


def upgrade() -> None:
    execute(r"""
      CREATE TABLE service.whatsapp_form_template_policy (
        tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
        channel_id uuid NOT NULL,
        template_name text NOT NULL CHECK(char_length(template_name) BETWEEN 1 AND 512 AND template_name ~ '^[a-z0-9_]+$'),
        template_language text NOT NULL CHECK(template_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
        provider_template_id text NOT NULL CHECK(provider_template_id ~ '^[0-9]+$'),
        public_origin text NOT NULL CHECK(public_origin ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'),
        enabled boolean NOT NULL DEFAULT false,
        reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(tenant_id,channel_id) REFERENCES messaging.channels(tenant_id,id) ON DELETE CASCADE
      );
      ALTER TABLE service.whatsapp_form_template_policy ENABLE ROW LEVEL SECURITY;
      ALTER TABLE service.whatsapp_form_template_policy FORCE ROW LEVEL SECURITY;
      CREATE POLICY whatsapp_form_template_tenant ON service.whatsapp_form_template_policy
        USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
      GRANT SELECT,INSERT,UPDATE,DELETE ON service.whatsapp_form_template_policy TO platform_migrator;

      CREATE FUNCTION service.summary_locale() RETURNS text
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT coalesce((SELECT locale FROM crm.tenant_settings
            WHERE tenant_id=platform.current_tenant_id()),'en')
          WHERE platform.current_tenant_active() AND service.field_service_enabled()
            AND platform.current_tenant_feature_enabled('field_service')
        $$;

      CREATE FUNCTION service.whatsapp_form_template_configuration(p_channel uuid DEFAULT NULL) RETURNS jsonb
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT jsonb_build_object('templateName',policy.template_name,'language',policy.template_language,
            'channelId',policy.channel_id,'publicOrigin',policy.public_origin)
          FROM service.whatsapp_form_template_policy policy
          JOIN messaging.channels channel ON channel.tenant_id=policy.tenant_id AND channel.id=policy.channel_id
          WHERE policy.tenant_id=platform.current_tenant_id() AND policy.enabled
            AND (p_channel IS NULL OR policy.channel_id=p_channel)
            AND channel.kind='whatsapp' AND channel.provider='meta' AND channel.status='active'
            AND platform.current_tenant_active() AND service.field_service_enabled()
            AND platform.current_tenant_feature_enabled('field_service')
            AND platform.current_tenant_feature_enabled('whatsapp')
            AND platform.current_tenant_feature_enabled('tickets')
            AND service.current_workflow_policy()#>>'{whatsappFollowUp,mode}'='form'
            AND service.current_workflow_policy()#>>'{whatsappFollowUp,enabled}'='true'
        $$;

      CREATE FUNCTION platform.whatsapp_template_request_allowed(p_request messaging.outbound_requests) RETURNS boolean
        LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_link text; v_token text; v_policy service.whatsapp_form_template_policy%ROWTYPE;
        BEGIN
          IF p_request.tenant_id IS DISTINCT FROM platform.current_tenant_id() THEN RETURN false; END IF;
          IF platform.whatsapp_templates_enabled() THEN RETURN true; END IF;
          IF p_request.message_kind IS DISTINCT FROM 'template' OR p_request.provider IS DISTINCT FROM 'meta'
            OR NOT coalesce(p_request.explicitly_confirmed,false)
            OR jsonb_typeof(p_request.template_parameters) IS DISTINCT FROM 'array'
            OR jsonb_array_length(p_request.template_parameters)<>1
            OR jsonb_typeof(p_request.template_parameters->0) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
          SELECT * INTO v_policy FROM service.whatsapp_form_template_policy
            WHERE tenant_id=platform.current_tenant_id() AND channel_id=p_request.channel_id AND enabled
              AND template_name=p_request.template_name AND template_language=p_request.template_language;
          IF NOT FOUND OR service.whatsapp_form_template_configuration(p_request.channel_id) IS NULL THEN RETURN false; END IF;
          v_link:=p_request.template_parameters->>0;
          v_token:=right(v_link,64);
          IF v_token !~ '^[0-9a-f]{64}$' OR v_link IS DISTINCT FROM
            v_policy.public_origin||'/service-request#tenant='||p_request.tenant_id::text||'&token='||v_token THEN RETURN false; END IF;
          RETURN EXISTS(
            SELECT 1 FROM service.intake_drafts intake
            JOIN service.digital_intake_forms form ON form.tenant_id=intake.tenant_id AND form.intake_id=intake.id
            JOIN messaging.messages message ON message.tenant_id=intake.tenant_id AND message.id=p_request.message_id
            WHERE intake.tenant_id=platform.current_tenant_id()
              AND p_request.idempotency_key='service-followup:'||intake.id::text
              AND intake.source_session_id IS NOT NULL
              AND intake.workflow_policy#>>'{whatsappFollowUp,mode}'='form'
              AND intake.workflow_policy#>>'{whatsappFollowUp,enabled}'='true'
              AND intake.status IN ('collecting','awaiting_confirmation')
              AND intake.followup_status IN ('requested','queued','admitted')
              AND (intake.followup_message_id IS NULL OR intake.followup_message_id=p_request.message_id)
              AND nullif(btrim(intake.collected_fields->>'customerName'),'') IS NOT NULL
              AND nullif(btrim(intake.collected_fields->>'faultDescription'),'') IS NOT NULL
              AND form.submitted_at IS NULL AND form.expires_at>clock_timestamp()
              AND form.token_hash=encode(sha256(convert_to(v_token,'UTF8')),'hex')
              AND message.sender_type='system' AND message.content_type='template'
              AND message.conversation_id=p_request.conversation_id
              AND message.sender_user_id=p_request.requested_by_user_id
              AND message.structured_content=jsonb_build_object('templateName',p_request.template_name,
                'language',p_request.template_language,'parameters',p_request.template_parameters)
              AND service.verified_followup_recipient(intake.id,p_request.conversation_id,
                p_request.recipient_identity_id,p_request.recipient_address)
          );
        END $$;

      CREATE FUNCTION platform.guard_whatsapp_template_request() RETURNS trigger
        LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
          IF NOT platform.whatsapp_template_request_allowed(NEW) THEN
            RAISE EXCEPTION 'WhatsApp template is not authorized for this request' USING ERRCODE='42501';
          END IF;
          RETURN NEW;
        END $$;
      DROP TRIGGER whatsapp_template_tenant ON messaging.outbound_requests;
      CREATE TRIGGER whatsapp_template_tenant BEFORE INSERT OR UPDATE OF tenant_id,conversation_id,message_id,
        channel_id,recipient_identity_id,recipient_address,requested_by_user_id,provider,message_kind,
        template_name,template_language,template_parameters,explicitly_confirmed,idempotency_key
        ON messaging.outbound_requests FOR EACH ROW WHEN(NEW.message_kind='template')
        EXECUTE FUNCTION platform.guard_whatsapp_template_request();
    """)
    # The voice guard must admit only the reviewed exception, before any link
    # is queued. It continues to require an existing window for all other forms.
    op.execute("""DO $patch$
      DECLARE definition text:=pg_get_functiondef('service.request_intake_followup(uuid,boolean)'::regprocedure);
        needle text:='AND NOT EXISTS(SELECT 1 FROM messaging.conversations conversation';
      BEGIN
        IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
          RAISE EXCEPTION 'Unexpected service form admission predecessor'; END IF;
        EXECUTE replace(definition,needle,'AND service.whatsapp_form_template_configuration() IS NULL '||needle);
      END $patch$""")
    # A first-time caller has no conversation until this worker prepares it.
    # The old menu gate cancelled the immediate job while the call was still
    # active. Admit only the reviewed, consented form path in that interval.
    op.execute("""DO $patch$
      DECLARE definition text:=pg_get_functiondef('platform.opening_menu_business_job_allowed(uuid,text,uuid)'::regprocedure);
        needle text:='AND session.status=''ended''';
      BEGIN
        IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
          RAISE EXCEPTION 'Unexpected first-caller job predecessor'; END IF;
        EXECUTE replace(definition,needle,$replacement$AND (session.status='ended' OR (
          session.status='started' AND session.ended_at IS NULL
          AND draft.workflow_policy#>>'{whatsappFollowUp,mode}'='form'
          AND draft.workflow_policy#>>'{whatsappFollowUp,trigger}'='intake_saved'
          AND nullif(btrim(draft.collected_fields->>'customerName'),'') IS NOT NULL
          AND nullif(btrim(draft.collected_fields->>'faultDescription'),'') IS NOT NULL
          AND service.whatsapp_form_template_configuration() IS NOT NULL
          AND service.voice_session_caller_identity(j.tenant_id,session.session_id) IS NOT NULL
          AND EXISTS(SELECT 1 FROM crm.contacts contact WHERE contact.tenant_id=j.tenant_id
            AND contact.id=session.contact_id AND contact.whatsapp_consent='granted'
            AND contact.whatsapp_opted_out_at IS NULL AND contact.lifecycle_status='active')
          AND NOT EXISTS(SELECT 1 FROM public.voice_session_controls control
            WHERE control.tenant_id=j.tenant_id AND control.session_id=session.session_id
              AND control.desired_mode<>'ai')
        ))$replacement$);
      END $patch$""")
    for signature in (
        "service.summary_locale()",
        "service.whatsapp_form_template_configuration(uuid)",
        "platform.whatsapp_template_request_allowed(messaging.outbound_requests)",
        "platform.guard_whatsapp_template_request()",
    ):
        op.execute(f"ALTER FUNCTION {signature} OWNER TO platform_migrator")
        op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
    op.execute("""GRANT EXECUTE ON FUNCTION service.whatsapp_form_template_configuration(uuid),
      platform.whatsapp_template_request_allowed(messaging.outbound_requests)
      TO platform_web,platform_voice,platform_messaging,platform_migrator""")
    op.execute(
        "GRANT EXECUTE ON FUNCTION service.summary_locale() TO platform_messaging,platform_migrator"
    )


def downgrade() -> None:
    # Keep the scoped guard and durable bindings for in-flight mixed-version
    # requests. Operators can revoke the exception by disabling its policy.
    raise RuntimeError(
        "Scoped service form delivery is forward-only; roll back compatible "
        "application images while retaining revision e6a91c4f208b."
    )
