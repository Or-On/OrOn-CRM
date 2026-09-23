"""Traceable phone intake: early inquiry, WhatsApp follow-up and reply correlation.

A configured tenant sees a phone inquiry in the ticket inbox as soon as the
call is admitted, independent of any model summary or end-of-call callback.
The call's end settles the inquiry into an explicit, visible disposition. A
WhatsApp follow-up is rendered and addressed by the server, never the model,
and customer replies attach to the same inquiry only when the correlation is
unambiguous; ambiguous replies are held for a person to link.

Revision ID: 6f8b0d3e5a29
Revises: 5e7a9c2d4f18
"""

# ruff: noqa: E501, S608 -- SQL uses migration-owned constants only.
from collections.abc import Sequence

from alembic import op

revision: str = "6f8b0d3e5a29"
down_revision: str | None = "5e7a9c2d4f18"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INTAKE_KEYS = "'customerName','chainName','storeName','storeId','serviceAddress','faultDescription','exactFailure','productType','productModel','serialNumber','warrantyStatus','callbackNumber','urgency'"
OPEN_INTAKE = "('collecting','awaiting_confirmation','confirmed')"


def _execute(sql: str) -> None:
    """Execute one statement at a time, retaining dollar-quoted function bodies."""
    pending = ""
    for index, part in enumerate(sql.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
        else:
            statements = part.split(";")
            pending += statements[0]
            for statement in statements[1:]:
                if pending.strip():
                    op.execute(pending.replace(":", r"\:"))
                pending = statement
    if pending.strip():
        op.execute(pending.replace(":", r"\:"))


def upgrade() -> None:
    _schema()
    _helpers()
    _voice_inquiry()
    _followup()
    _correlation()
    _settlement()
    _grants()


def _schema() -> None:
    _execute(f"""
      ALTER TABLE ops.inbound_events DROP CONSTRAINT ck_inbound_event_status;
      ALTER TABLE ops.inbound_events ADD CONSTRAINT ck_inbound_event_status
        CHECK (status IN ('received','processing','processed','failed','ignored','quarantined'));

      ALTER TABLE support.tickets ADD COLUMN intake_draft_id uuid,
        ADD CONSTRAINT fk_support_ticket_intake FOREIGN KEY (tenant_id,intake_draft_id)
          REFERENCES service.intake_drafts(tenant_id,id) ON DELETE SET NULL (intake_draft_id);
      CREATE UNIQUE INDEX uq_support_ticket_intake ON support.tickets(tenant_id,intake_draft_id) WHERE intake_draft_id IS NOT NULL;

      ALTER TABLE service.intake_drafts
        ADD COLUMN followup_status text NOT NULL DEFAULT 'not_requested',
        ADD COLUMN followup_requested_at timestamptz,
        ADD COLUMN followup_message_id uuid,
        ADD COLUMN followup_error_safe text,
        ADD COLUMN customer_replied_at timestamptz,
        ADD COLUMN customer_media_received_at timestamptz,
        ADD CONSTRAINT ck_intake_followup_status CHECK (followup_status IN
          ('not_requested','requested','queued','admitted','blocked_consent','blocked_window','no_channel','no_recipient','recipient_conflict','failed')),
        ADD CONSTRAINT ck_intake_followup_error CHECK (followup_error_safe IS NULL OR char_length(followup_error_safe) BETWEEN 1 AND 200),
        ADD CONSTRAINT fk_intake_followup_message FOREIGN KEY (tenant_id,followup_message_id)
          REFERENCES messaging.messages(tenant_id,id) ON DELETE SET NULL (followup_message_id);

      -- A customer message that could belong to more than one open inquiry is
      -- never attached by guesswork. It waits here for a person to link it.
      CREATE TABLE service.followup_triage (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
        message_id uuid NOT NULL,
        candidate_intake_ids uuid[] NOT NULL CHECK (cardinality(candidate_intake_ids) BETWEEN 2 AND 50),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        resolved_intake_id uuid,
        resolved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        resolved_at timestamptz,
        UNIQUE (tenant_id,id),
        UNIQUE (tenant_id,message_id),
        FOREIGN KEY (tenant_id,message_id) REFERENCES messaging.messages(tenant_id,id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id,resolved_intake_id) REFERENCES service.intake_drafts(tenant_id,id) ON DELETE SET NULL (resolved_intake_id),
        CONSTRAINT ck_followup_triage_resolution CHECK (num_nonnulls(resolved_intake_id,resolved_at) IN (0,2)));
      CREATE INDEX ix_followup_triage_open ON service.followup_triage(tenant_id,created_at DESC) WHERE resolved_at IS NULL;
      ALTER TABLE service.followup_triage ENABLE ROW LEVEL SECURITY;
      ALTER TABLE service.followup_triage FORCE ROW LEVEL SECURITY;
      CREATE POLICY followup_triage_tenant_isolation ON service.followup_triage
        USING (tenant_id=platform.current_tenant_id()) WITH CHECK (tenant_id=platform.current_tenant_id());
      CREATE POLICY followup_triage_staff_only ON service.followup_triage AS RESTRICTIVE
        USING (coalesce(current_setting('app.current_role',true),'') IN ('owner','admin','agent','service'))
        WITH CHECK (coalesce(current_setting('app.current_role',true),'') IN ('owner','admin','agent','service'));
    """)


def _helpers() -> None:
    _execute("""
      -- One timeline append with an explicit tenant, usable from triggers that
      -- run without request context (for example the stale-session sweeper).
      CREATE FUNCTION support.append_ticket_event(p_tenant uuid,p_ticket uuid,p_kind text,p_actor text,p_summary text,p_evidence jsonb)
      RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_sequence integer;
      BEGIN
        UPDATE support.tickets SET next_event_sequence=next_event_sequence+1,last_activity_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=p_tenant AND id=p_ticket RETURNING next_event_sequence INTO v_sequence;
        IF v_sequence IS NULL THEN RETURN NULL; END IF;
        INSERT INTO support.ticket_events(tenant_id,ticket_id,sequence,kind,actor_kind,visibility,summary_safe,evidence)
          VALUES(p_tenant,p_ticket,v_sequence,p_kind,p_actor,'internal',left(p_summary,2000),coalesce(p_evidence,'{}'::jsonb));
        RETURN v_sequence;
      END $$;

      CREATE FUNCTION service.tenant_is_hebrew(p_tenant uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT coalesce((SELECT lower(locale::text) LIKE 'he%' FROM crm.tenant_settings WHERE tenant_id=p_tenant),false)
      $$;

      -- The caller identity pinned when the agent was bound to the call: the
      -- telephony-provided number resolved against the contact, never a
      -- number spoken by the caller or proposed by the model.
      CREATE FUNCTION service.voice_session_caller_identity(p_tenant uuid,p_session uuid) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT identity.id FROM public.session_events event
          JOIN crm.contact_channel_identities identity ON identity.tenant_id=event.tenant_id
           AND identity.id=(event.payload->>'caller_identity_id')::uuid
          JOIN public.sessions session ON session.tenant_id=event.tenant_id AND session.session_id=event.session_id
           AND session.contact_id=identity.contact_id
        WHERE event.tenant_id=p_tenant AND event.session_id=p_session AND event.event_type='voice.agent.binding.v1'
          AND identity.channel IN ('phone','whatsapp') AND identity.validation_status NOT IN ('invalid','revoked')
          AND identity.normalized_value ~ '^\\+[1-9][0-9]{7,14}$'
        ORDER BY event.sequence LIMIT 1
      $$;
    """)


def _voice_inquiry() -> None:
    _execute(f"""
      -- The minimal durable intake plus its inquiry, created at admission for
      -- tenants whose policy opens inquiries on first contact. Idempotent.
      CREATE FUNCTION service.open_voice_inquiry(p_session uuid) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_context jsonb; v_policy jsonb; v_contact uuid; v_intake uuid;
        v_receipt jsonb; v_hebrew boolean;
      BEGIN
        v_context:=service.voice_intake_context(p_session);
        v_policy:=v_context->'policy';
        IF coalesce((v_policy#>>'{{inquiry,openOnFirstContact}}')::boolean,false) IS NOT TRUE THEN
          RETURN jsonb_build_object('status','not_configured'); END IF;
        IF v_context->>'status'='identity_required' THEN RETURN jsonb_build_object('status','identity_required'); END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text||':voice-service:'||p_session::text,0));
        SELECT contact_id INTO v_contact FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session;
        INSERT INTO service.intake_drafts(tenant_id,source_session_id,reporting_contact_id,customer_contact_id,customer_resolution_status,correlation_key,collected_fields,status)
          VALUES(v_tenant,p_session,v_contact,v_contact,'reporting_contact','voice:'||p_session::text,coalesce(v_context->'knownFields','{{}}'::jsonb),'collecting')
          ON CONFLICT(tenant_id,source_session_id) WHERE source_session_id IS NOT NULL DO NOTHING;
        SELECT id INTO v_intake FROM service.intake_drafts WHERE tenant_id=v_tenant AND source_session_id=p_session;
        UPDATE service.intake_drafts SET workflow_policy=v_policy WHERE tenant_id=v_tenant AND id=v_intake AND workflow_policy IS DISTINCT FROM v_policy
          AND NOT EXISTS(SELECT 1 FROM service.cases WHERE tenant_id=v_tenant AND intake_draft_id=v_intake);
        v_hebrew:=service.tenant_is_hebrew(v_tenant);
        v_receipt:=support.open_ticket_from_voice_session(p_session,
          CASE WHEN v_hebrew THEN 'פנייה טלפונית' ELSE 'Phone inquiry' END,
          CASE WHEN v_hebrew THEN 'שיחה נכנסת התחילה. פרטי השירות נאספים.' ELSE 'Inbound call started. Service details are being collected.' END);
        UPDATE support.tickets SET intake_draft_id=v_intake WHERE tenant_id=v_tenant AND attachment_key='voice-session:'||p_session::text AND intake_draft_id IS NULL;
        IF (v_receipt->>'created')::boolean IS TRUE THEN
          INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
            VALUES(v_tenant,'voice-intake','field_service.inquiry.opened','intake_draft',v_intake,jsonb_build_object('sessionId',p_session,'ticketId',v_receipt->>'ticketId'));
        END IF;
        RETURN jsonb_build_object('status','open','intakeId',v_intake,'ticketId',v_receipt->>'ticketId','reference',v_receipt->>'reference');
      END $$;

      CREATE OR REPLACE FUNCTION service.capture_service_intake(p_session uuid,p_fields jsonb,p_confirmed boolean) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_context jsonb; v_tenant uuid:=platform.current_tenant_id(); v_contact uuid; v_fields jsonb; v_policy jsonb;
        v_intake uuid; v_case uuid; v_location uuid; v_chain uuid; v_key text; v_value jsonb; v_missing jsonb; v_reference text; v_conversation uuid;
        v_ticket support.tickets%ROWTYPE; v_changed text[]:=ARRAY[]::text[]; v_urgency text;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text||':voice-service:'||p_session::text,0));
        v_context:=service.voice_intake_context(p_session);
        IF v_context->>'status'='identity_required' THEN RAISE EXCEPTION 'verify caller identity first' USING ERRCODE='42501'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session AND ended_at IS NULL)
          OR EXISTS(SELECT 1 FROM public.voice_session_controls WHERE tenant_id=v_tenant AND session_id=p_session AND desired_mode<>'ai') THEN
          RAISE EXCEPTION 'voice conversation no longer permits agent actions' USING ERRCODE='42501'; END IF;
        IF v_context->>'caseId' IS NOT NULL THEN RETURN v_context; END IF;
        IF jsonb_typeof(p_fields) IS DISTINCT FROM 'object' OR octet_length(p_fields::text)>16384 THEN RAISE EXCEPTION 'invalid intake fields' USING ERRCODE='22023'; END IF;
        v_fields:=v_context->'knownFields'; v_policy:=v_context->'policy';
        FOR v_key,v_value IN SELECT key,value FROM jsonb_each(p_fields) LOOP
          IF v_key NOT IN ({INTAKE_KEYS}) OR jsonb_typeof(v_value)<>'string' THEN
            RAISE EXCEPTION 'unsupported intake field' USING ERRCODE='22023'; END IF;
          IF length(btrim(v_value#>>'{{}}'))>(CASE WHEN v_key='faultDescription' THEN 10000 WHEN v_key='exactFailure' THEN 2000 WHEN v_key='serviceAddress' THEN 500 ELSE 160 END) THEN RAISE EXCEPTION 'intake field too long' USING ERRCODE='22023'; END IF;
          IF v_key='urgency' AND btrim(v_value#>>'{{}}') NOT IN ('low','normal','high','urgent') THEN RAISE EXCEPTION 'unsupported urgency' USING ERRCODE='22023'; END IF;
          IF v_key='callbackNumber' AND nullif(btrim(v_value#>>'{{}}'),'') IS NOT NULL AND btrim(v_value#>>'{{}}') !~ '^\\+?[0-9][0-9 ()-]{{6,22}}$' THEN RAISE EXCEPTION 'invalid callback number' USING ERRCODE='22023'; END IF;
          IF nullif(btrim(v_value#>>'{{}}'),'') IS NOT NULL THEN
            IF v_fields->>v_key IS DISTINCT FROM btrim(v_value#>>'{{}}') THEN v_changed:=array_append(v_changed,v_key); END IF;
            v_fields:=v_fields||jsonb_build_object(v_key,btrim(v_value#>>'{{}}'));
          END IF;
        END LOOP;
        IF v_fields->>'storeId' IS NOT NULL THEN
          SELECT location.id,location.chain_id INTO v_location,v_chain FROM crm.service_locations location WHERE location.tenant_id=v_tenant AND location.id=(v_fields->>'storeId')::uuid AND location.archived_at IS NULL;
          IF v_location IS NULL THEN RAISE EXCEPTION 'store is not in tenant directory' USING ERRCODE='22023'; END IF;
          SELECT v_fields||jsonb_strip_nulls(jsonb_build_object('storeName',location.name,'serviceAddress',location.address,'chainName',chain.name)) INTO v_fields
            FROM crm.service_locations location LEFT JOIN crm.service_chains chain ON chain.tenant_id=location.tenant_id AND chain.id=location.chain_id WHERE location.tenant_id=v_tenant AND location.id=v_location;
        END IF;
        SELECT contact_id INTO v_contact FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session;
        v_missing:=service.intake_missing_fields(v_fields,v_policy);
        IF p_fields->>'customerName' IS NOT NULL THEN
          UPDATE crm.contacts SET name=v_fields->>'customerName',updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND id=v_contact AND name ~ '^\\+?[0-9 ()-]{{7,}}$';
        END IF;
        INSERT INTO service.intake_drafts(tenant_id,source_session_id,reporting_contact_id,customer_contact_id,customer_resolution_status,correlation_key,collected_fields,status)
        VALUES(v_tenant,p_session,v_contact,v_contact,'reporting_contact','voice:'||p_session::text,v_fields,CASE WHEN jsonb_array_length(v_missing)=0 THEN 'awaiting_confirmation' ELSE 'collecting' END)
        ON CONFLICT(tenant_id,source_session_id) WHERE source_session_id IS NOT NULL DO UPDATE SET collected_fields=EXCLUDED.collected_fields,status=EXCLUDED.status,updated_at=CURRENT_TIMESTAMP RETURNING id INTO v_intake;
        UPDATE service.intake_drafts SET workflow_policy=v_policy WHERE tenant_id=v_tenant AND id=v_intake;
        -- Incremental visibility: the inquiry reflects each saved fact as it is
        -- captured, so a dropped call leaves what the caller already said.
        SELECT * INTO v_ticket FROM support.tickets WHERE tenant_id=v_tenant AND attachment_key='voice-session:'||p_session::text FOR UPDATE;
        IF FOUND AND v_ticket.status='open' THEN
          v_urgency:=v_fields->>'urgency';
          UPDATE support.tickets SET intake_draft_id=coalesce(intake_draft_id,v_intake),
            subject=CASE WHEN 'faultDescription'=ANY(v_changed) THEN left(regexp_replace(v_fields->>'faultDescription','\\s+',' ','g'),200) ELSE subject END,
            priority=CASE WHEN emergency_at IS NOT NULL THEN 'urgent' WHEN v_urgency IN ('low','normal','high','urgent') THEN v_urgency ELSE priority END,
            updated_at=clock_timestamp()
            WHERE tenant_id=v_tenant AND id=v_ticket.id;
          IF cardinality(v_changed)>0 THEN
            PERFORM support.append_ticket_event(v_tenant,v_ticket.id,'customer_update','customer',
              'Service details captured: '||array_to_string(v_changed,', '),jsonb_build_object('fields',to_jsonb(v_changed),'intakeId',v_intake));
          END IF;
        END IF;
        IF NOT coalesce(p_confirmed,false) OR jsonb_array_length(v_missing)>0 THEN RETURN service.voice_intake_context(p_session); END IF;
        IF v_policy->>'photoPolicy'='required' AND NOT EXISTS(SELECT 1 FROM service.intake_messages im JOIN messaging.messages m ON m.tenant_id=im.tenant_id AND m.id=im.message_id JOIN objects.object_metadata o ON o.tenant_id=m.tenant_id AND o.id=m.object_id WHERE im.tenant_id=v_tenant AND im.intake_draft_id=v_intake AND m.content_type='image' AND o.status='available' AND o.deleted_at IS NULL) THEN
          RETURN service.voice_intake_context(p_session)||jsonb_build_object('missingFields',v_missing||'["photos"]'::jsonb);
        END IF;
        IF v_location IS NULL AND v_fields->>'storeName' IS NOT NULL THEN
          IF v_fields->>'chainName' IS NOT NULL THEN
            SELECT id INTO v_chain FROM crm.service_chains WHERE tenant_id=v_tenant AND lower(name)=lower(v_fields->>'chainName') AND active;
            IF v_chain IS NULL THEN INSERT INTO crm.service_chains(tenant_id,name) VALUES(v_tenant,v_fields->>'chainName') ON CONFLICT(tenant_id,lower(name)) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO v_chain; END IF;
          END IF;
          SELECT id INTO v_location FROM crm.service_locations WHERE tenant_id=v_tenant AND chain_id IS NOT DISTINCT FROM v_chain AND lower(name)=lower(v_fields->>'storeName') AND archived_at IS NULL ORDER BY id LIMIT 1;
          IF v_location IS NULL THEN INSERT INTO crm.service_locations(tenant_id,customer_contact_id,chain_id,name,address) VALUES(v_tenant,v_contact,v_chain,v_fields->>'storeName',v_fields->>'serviceAddress') RETURNING id INTO v_location; END IF;
        END IF;
        v_case:=gen_random_uuid(); v_reference:='FS-'||to_char(CURRENT_TIMESTAMP,'YYYY')||'-'||upper(left(replace(v_case::text,'-',''),8));
        SELECT conversation_id INTO v_conversation FROM service.intake_drafts WHERE tenant_id=v_tenant AND id=v_intake;
        INSERT INTO service.cases(id,tenant_id,reference,customer_contact_id,reporting_contact_id,service_location_id,intake_draft_id,conversation_id,title,fault_description,product_type,product_model,serial_number,source,priority)
        VALUES(v_case,v_tenant,v_reference,v_contact,v_contact,v_location,v_intake,v_conversation,left(v_fields->>'faultDescription',200),left((v_fields->>'faultDescription')||CASE WHEN v_fields->>'exactFailure' IS NULL THEN '' ELSE E'\\n'||(v_fields->>'exactFailure') END,10000),v_fields->>'productType',v_fields->>'productModel',v_fields->>'serialNumber','voice',
          CASE WHEN v_ticket.emergency_at IS NOT NULL THEN 'urgent' WHEN v_fields->>'urgency' IN ('low','normal','high','urgent') THEN v_fields->>'urgency' ELSE 'normal' END);
        UPDATE service.cases SET workflow_policy=service.redact_workflow_policy(v_policy) WHERE tenant_id=v_tenant AND id=v_case;
        INSERT INTO service.case_calls(tenant_id,case_id,session_id,relationship) VALUES(v_tenant,v_case,p_session,'intake');
        IF v_conversation IS NOT NULL THEN INSERT INTO service.case_conversations(tenant_id,case_id,conversation_id,relationship) VALUES(v_tenant,v_case,v_conversation,'intake') ON CONFLICT DO NOTHING; END IF;
        INSERT INTO service.report_attachments(tenant_id,case_id,message_id,object_id,category,source,processing_status)
          SELECT v_tenant,v_case,m.id,m.object_id,CASE WHEN m.content_type='image' THEN 'customer_photo' ELSE 'document' END,'customer','available'
          FROM service.intake_messages im JOIN messaging.messages m ON m.tenant_id=im.tenant_id AND m.id=im.message_id
          JOIN objects.object_metadata o ON o.tenant_id=m.tenant_id AND o.id=m.object_id
          WHERE im.tenant_id=v_tenant AND im.intake_draft_id=v_intake AND m.direction='inbound' AND m.content_type IN ('image','document') AND o.status='available' AND o.deleted_at IS NULL ON CONFLICT DO NOTHING;
        INSERT INTO service.case_status_history(tenant_id,case_id,to_status,actor_service) VALUES(v_tenant,v_case,'awaiting_scheduling','voice-intake');
        UPDATE service.intake_drafts SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND id=v_intake;
        INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata) VALUES(v_tenant,'voice-intake','field_service.intake.confirmed','service_case',v_case,jsonb_build_object('sessionId',p_session,'intakeId',v_intake));
        RETURN service.voice_intake_context(p_session);
      END $$;

      -- Voice emergency: persist first (creating the inquiry when needed),
      -- then return only whether a transfer target exists. The number itself
      -- goes to the trusted runtime through service.voice_emergency_transfer.
      -- Voice emergency: persist first, then return only whether a transfer
      -- target exists. The number goes to the trusted runtime through
      -- service.voice_emergency_transfer and never to the model. A caller
      -- with no identifiable number still escalates: staff are notified and
      -- the session carries the disposition.
      CREATE FUNCTION service.voice_session_event(p_tenant uuid,p_session uuid,p_type text,p_payload jsonb) RETURNS void
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        PERFORM 1 FROM public.sessions WHERE tenant_id=p_tenant AND session_id=p_session FOR UPDATE;
        INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,version,payload,occurred_at)
          SELECT p_tenant,p_session,coalesce(max(sequence),-1)+1,p_type,1,p_payload,clock_timestamp()
          FROM public.session_events WHERE tenant_id=p_tenant AND session_id=p_session;
      END $$;

      CREATE FUNCTION service.escalate_voice_emergency(p_session uuid,p_reason text) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_full jsonb; v_ticket uuid; v_open jsonb; v_contact uuid; v_agent uuid;
      BEGIN
        IF NOT service.field_service_enabled() OR NOT platform.current_tenant_feature_enabled('voice') OR NOT platform.current_tenant_active() THEN
          RAISE EXCEPTION 'service intake unavailable' USING ERRCODE='42501'; END IF;
        SELECT configuration->'workflow' INTO v_full FROM platform.tenant_feature_entitlements WHERE tenant_id=v_tenant AND feature_key='field_service';
        IF coalesce((v_full#>>'{{emergency,enabled}}')::boolean,false) IS NOT TRUE THEN
          RETURN jsonb_build_object('status','not_configured'); END IF;
        SELECT (payload->>'agent_version_id')::uuid INTO v_agent FROM public.session_events WHERE tenant_id=v_tenant AND session_id=p_session AND event_type='voice.agent.binding.v1' ORDER BY sequence LIMIT 1;
        IF NOT EXISTS(SELECT 1 FROM agents.agent_profile_versions WHERE tenant_id=v_tenant AND id=v_agent AND published_at IS NOT NULL AND validation_status='valid' AND tool_permissions ? 'service.intake') THEN
          RAISE EXCEPTION 'published service intake capability required' USING ERRCODE='42501'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session AND ended_at IS NULL)
          OR EXISTS(SELECT 1 FROM public.voice_session_controls WHERE tenant_id=v_tenant AND session_id=p_session AND desired_mode<>'ai') THEN
          RAISE EXCEPTION 'voice conversation no longer permits agent actions' USING ERRCODE='42501'; END IF;
        IF char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'an urgency reason is required' USING ERRCODE='22023'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.session_events WHERE tenant_id=v_tenant AND session_id=p_session AND event_type='voice.emergency.v1') THEN
          PERFORM service.voice_session_event(v_tenant,p_session,'voice.emergency.v1',jsonb_build_object('source','voice_agent'));
        END IF;
        SELECT contact_id INTO v_contact FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session;
        IF v_contact IS NULL THEN
          INSERT INTO messaging.notifications(tenant_id,user_id,type,title,body,reference_type,reference_id)
            SELECT v_tenant,recipient.user_id,'support.emergency','Urgent call from an unidentified caller',
              left(btrim(p_reason),240),'voice_session',p_session
            FROM platform.current_tenant_notification_recipients() recipient
            WHERE NOT EXISTS(SELECT 1 FROM messaging.notifications n WHERE n.tenant_id=v_tenant AND n.reference_type='voice_session' AND n.reference_id=p_session AND n.type='support.emergency');
          RETURN jsonb_build_object('status','escalated_without_inquiry',
            'transferAvailable',(v_full#>>'{{emergency,transferTo}}') IS NOT NULL,'fallback',coalesce(v_full#>>'{{emergency,fallback}}','urgent_followup'));
        END IF;
        SELECT id INTO v_ticket FROM support.tickets WHERE tenant_id=v_tenant AND attachment_key='voice-session:'||p_session::text;
        IF v_ticket IS NULL THEN
          v_open:=support.open_ticket_from_voice_session(p_session,
            CASE WHEN service.tenant_is_hebrew(v_tenant) THEN 'פנייה דחופה' ELSE 'Urgent inquiry' END,
            CASE WHEN service.tenant_is_hebrew(v_tenant) THEN 'המתקשר תיאר מצב חירום.' ELSE 'The caller described an emergency.' END);
          v_ticket:=(v_open->>'ticketId')::uuid;
          UPDATE support.tickets SET intake_draft_id=(SELECT id FROM service.intake_drafts WHERE tenant_id=v_tenant AND source_session_id=p_session)
            WHERE tenant_id=v_tenant AND id=v_ticket AND intake_draft_id IS NULL;
        END IF;
        PERFORM support.mark_ticket_emergency(v_ticket,p_reason,'voice');
        RETURN jsonb_build_object('status','escalated','ticketId',v_ticket,
          'transferAvailable',(v_full#>>'{{emergency,transferTo}}') IS NOT NULL,'fallback',coalesce(v_full#>>'{{emergency,fallback}}','urgent_followup'));
      END $$;

      CREATE FUNCTION service.voice_emergency_transfer(p_session uuid) RETURNS text
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id();
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.session_events WHERE tenant_id=v_tenant AND session_id=p_session AND event_type='voice.emergency.v1')
          OR NOT EXISTS(SELECT 1 FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session AND ended_at IS NULL) THEN
          RETURN NULL; END IF;
        RETURN (SELECT configuration#>>'{{workflow,emergency,transferTo}}' FROM platform.tenant_feature_entitlements
          WHERE tenant_id=v_tenant AND feature_key='field_service' AND coalesce((configuration#>>'{{workflow,emergency,enabled}}')::boolean,false));
      END $$;

      CREATE FUNCTION service.record_voice_escalation(p_session uuid,p_outcome text) RETURNS integer
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_ticket uuid;
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.session_events WHERE tenant_id=v_tenant AND session_id=p_session AND event_type='voice.emergency.v1') THEN
          RAISE EXCEPTION 'no emergency was escalated in this call' USING ERRCODE='P0002'; END IF;
        IF p_outcome NOT IN ('transfer_initiated','transfer_failed','no_transfer_target','caller_disconnected','fallback_urgent_followup','fallback_staff_notified') THEN
          RAISE EXCEPTION 'unsupported escalation outcome' USING ERRCODE='22023'; END IF;
        PERFORM service.voice_session_event(v_tenant,p_session,'voice.escalation.v1',jsonb_build_object('outcome',p_outcome));
        SELECT id INTO v_ticket FROM support.tickets WHERE tenant_id=v_tenant AND attachment_key='voice-session:'||p_session::text AND emergency_at IS NOT NULL;
        IF v_ticket IS NULL THEN RETURN 0; END IF;
        RETURN support.record_ticket_escalation(v_ticket,p_outcome,'voice-agent');
      END $$;
    """)


def _followup() -> None:
    _execute(f"""
      CREATE FUNCTION service.enqueue_intake_followup(p_tenant uuid,p_intake uuid,p_cause text) RETURNS uuid
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_job uuid; v_ticket uuid;
      BEGIN
        INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority)
          VALUES(p_tenant,'messaging','field_service.intake_followup','intake_draft',p_intake,
            jsonb_build_object('intakeId',p_intake,'cause',p_cause),'service-followup:'||p_intake::text,5,20)
          ON CONFLICT DO NOTHING RETURNING id INTO v_job;
        IF v_job IS NULL THEN
          SELECT id INTO v_job FROM ops.jobs WHERE tenant_id=p_tenant AND idempotency_key='service-followup:'||p_intake::text;
          RETURN v_job;
        END IF;
        UPDATE service.intake_drafts SET followup_status='queued',followup_error_safe=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=p_tenant AND id=p_intake AND followup_status IN ('not_requested','requested');
        SELECT id INTO v_ticket FROM support.tickets WHERE tenant_id=p_tenant AND intake_draft_id=p_intake AND status='open';
        IF v_ticket IS NOT NULL THEN
          PERFORM support.append_ticket_event(p_tenant,v_ticket,'agent_message','system',
            'WhatsApp follow-up queued. Delivery is not yet confirmed.',jsonb_build_object('jobId',v_job,'cause',p_cause));
        END IF;
        RETURN v_job;
      END $$;

      -- The caller asked, during the call, for the WhatsApp summary/photo
      -- request. Consent is recorded as the caller's agreement in this call,
      -- never over a revocation. Only the pinned telephony caller number is
      -- ever addressed. The model supplies no text and no destination.
      CREATE FUNCTION service.request_intake_followup(p_session uuid,p_customer_agreed boolean) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_context jsonb; v_policy jsonb; v_contact crm.contacts%ROWTYPE; v_intake uuid;
        v_identity uuid; v_job uuid;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text||':voice-service:'||p_session::text,0));
        v_context:=service.voice_intake_context(p_session);
        IF v_context->>'status'='identity_required' OR NOT EXISTS(SELECT 1 FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session AND ended_at IS NULL)
          OR EXISTS(SELECT 1 FROM public.voice_session_controls WHERE tenant_id=v_tenant AND session_id=p_session AND desired_mode<>'ai') THEN
          RAISE EXCEPTION 'voice conversation no longer permits agent actions' USING ERRCODE='42501'; END IF;
        v_policy:=v_context->'policy';
        IF coalesce((v_policy#>>'{{whatsappFollowUp,enabled}}')::boolean,false) IS NOT TRUE THEN
          RETURN jsonb_build_object('status','unavailable','reason','followup_not_configured'); END IF;
        IF NOT platform.current_tenant_feature_enabled('whatsapp') THEN RETURN jsonb_build_object('status','unavailable','reason','whatsapp_disabled'); END IF;
        v_intake:=(v_context->>'intakeId')::uuid;
        IF v_intake IS NULL THEN RAISE EXCEPTION 'intake must be saved before requesting a follow-up' USING ERRCODE='22023'; END IF;
        v_identity:=service.voice_session_caller_identity(v_tenant,p_session);
        IF v_identity IS NULL THEN
          UPDATE service.intake_drafts SET followup_status='no_recipient',followup_requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=v_intake;
          RETURN jsonb_build_object('status','unavailable','reason','no_verified_caller_number','intakeId',v_intake);
        END IF;
        SELECT contact.* INTO v_contact FROM crm.contacts contact JOIN public.sessions session ON session.tenant_id=contact.tenant_id AND session.contact_id=contact.id
          WHERE session.tenant_id=v_tenant AND session.session_id=p_session FOR UPDATE OF contact;
        IF v_contact.whatsapp_opted_out_at IS NOT NULL OR v_contact.whatsapp_consent='revoked' OR v_contact.lifecycle_status<>'active' THEN
          UPDATE service.intake_drafts SET followup_status='blocked_consent',followup_requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=v_intake;
          RETURN jsonb_build_object('status','unavailable','reason','consent_revoked','intakeId',v_intake);
        END IF;
        IF v_contact.whatsapp_consent<>'granted' THEN
          IF coalesce(p_customer_agreed,false) AND v_policy#>>'{{whatsappFollowUp,consent}}'='in_call_agreement' THEN
            UPDATE crm.contacts SET whatsapp_consent='granted',updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=v_contact.id AND whatsapp_consent='unknown';
            INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
              VALUES(v_tenant,'voice-intake','crm.contact.whatsapp_consent_granted','contact',v_contact.id,
                jsonb_build_object('source','voice_call','sessionId',p_session,'purpose','service_followup','intakeId',v_intake));
          ELSE
            UPDATE service.intake_drafts SET followup_status='blocked_consent',followup_requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=v_intake;
            RETURN jsonb_build_object('status','unavailable','reason','consent_required','intakeId',v_intake);
          END IF;
        END IF;
        UPDATE service.intake_drafts SET followup_status=CASE WHEN followup_status IN ('not_requested','blocked_consent','no_recipient') THEN 'requested' ELSE followup_status END,
          followup_requested_at=coalesce(followup_requested_at,clock_timestamp()),updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=v_intake;
        IF v_policy#>>'{{whatsappFollowUp,trigger}}'='intake_saved' THEN
          v_job:=service.enqueue_intake_followup(v_tenant,v_intake,'in_call_request');
          RETURN jsonb_build_object('status','queued','jobId',v_job,'intakeId',v_intake,'caseId',v_context->>'caseId');
        END IF;
        RETURN jsonb_build_object('status','deferred','intakeId',v_intake,'caseId',v_context->>'caseId','sendsWhen','call_ended');
      END $$;

      -- Kept for compatibility with running agents: the model's message is
      -- ignored and the server renders the follow-up itself.
      CREATE OR REPLACE FUNCTION service.request_voice_intake_photos(p_session uuid,p_message text) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_result jsonb;
      BEGIN
        v_result:=service.request_intake_followup(p_session,true);
        IF v_result->>'status'='deferred' THEN RETURN v_result||jsonb_build_object('status','queued'); END IF;
        RETURN v_result;
      END $$;

      -- Everything the messaging worker needs to render and address the
      -- follow-up, derived from durable server data only.
      CREATE FUNCTION service.intake_followup_plan(p_intake uuid) RETURNS jsonb
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_intake service.intake_drafts%ROWTYPE; v_identity uuid; v_policy jsonb;
      BEGIN
        SELECT * INTO v_intake FROM service.intake_drafts WHERE tenant_id=v_tenant AND id=p_intake;
        IF NOT FOUND THEN RAISE EXCEPTION 'intake not found' USING ERRCODE='P0002'; END IF;
        v_policy:=coalesce(v_intake.workflow_policy,service.current_workflow_policy());
        v_identity:=CASE WHEN v_intake.source_session_id IS NOT NULL THEN service.voice_session_caller_identity(v_tenant,v_intake.source_session_id) END;
        RETURN jsonb_build_object(
          'intakeId',v_intake.id,'status',v_intake.status,'followupStatus',v_intake.followup_status,'contactId',v_intake.reporting_contact_id,
          'sessionId',v_intake.source_session_id,'conversationId',v_intake.conversation_id,
          'fields',v_intake.collected_fields - 'customerPhone' - 'storeId' - 'nationalId',
          'missingFields',service.intake_missing_fields(v_intake.collected_fields,v_policy),
          'requestPhoto',coalesce((v_policy#>>'{{whatsappFollowUp,requestPhoto}}')::boolean,false) AND NOT service.intake_has_photo(v_intake.id),
          'followUp',v_policy->'whatsappFollowUp',
          'hebrew',service.tenant_is_hebrew(v_tenant),
          'reference',coalesce((SELECT reference FROM service.cases WHERE tenant_id=v_tenant AND intake_draft_id=v_intake.id),
            (SELECT reference FROM support.tickets WHERE tenant_id=v_tenant AND intake_draft_id=v_intake.id)),
          'caseId',(SELECT id FROM service.cases WHERE tenant_id=v_tenant AND intake_draft_id=v_intake.id),
          'callerIdentityId',v_identity,
          'consent',(SELECT whatsapp_consent FROM crm.contacts WHERE tenant_id=v_tenant AND id=v_intake.reporting_contact_id),
          'optedOut',(SELECT whatsapp_opted_out_at IS NOT NULL FROM crm.contacts WHERE tenant_id=v_tenant AND id=v_intake.reporting_contact_id));
      END $$;

      -- Resolve the WhatsApp recipient and conversation for a voice intake.
      -- The recipient is the pinned telephony caller number or its WhatsApp
      -- twin on the SAME contact. A number owned by another contact is a
      -- conflict and is never messaged.
      CREATE FUNCTION service.prepare_intake_followup_recipient(p_intake uuid) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_intake service.intake_drafts%ROWTYPE; v_caller crm.contact_channel_identities%ROWTYPE;
        v_whatsapp crm.contact_channel_identities%ROWTYPE; v_channel messaging.channels%ROWTYPE; v_conversation uuid; v_removed timestamptz;
      BEGIN
        SELECT * INTO v_intake FROM service.intake_drafts WHERE tenant_id=v_tenant AND id=p_intake FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'intake not found' USING ERRCODE='P0002'; END IF;
        IF v_intake.source_session_id IS NULL THEN RETURN jsonb_build_object('status','no_recipient'); END IF;
        SELECT * INTO v_caller FROM crm.contact_channel_identities WHERE tenant_id=v_tenant AND id=service.voice_session_caller_identity(v_tenant,v_intake.source_session_id);
        IF NOT FOUND OR v_caller.contact_id<>v_intake.reporting_contact_id THEN RETURN jsonb_build_object('status','no_recipient'); END IF;
        IF v_caller.channel='whatsapp' THEN v_whatsapp:=v_caller;
        ELSE
          SELECT * INTO v_whatsapp FROM crm.contact_channel_identities WHERE tenant_id=v_tenant AND channel='whatsapp' AND normalized_value=v_caller.normalized_value;
          IF FOUND AND v_whatsapp.contact_id<>v_caller.contact_id THEN RETURN jsonb_build_object('status','recipient_conflict'); END IF;
          IF FOUND AND v_whatsapp.validation_status IN ('invalid','revoked') THEN RETURN jsonb_build_object('status','no_recipient'); END IF;
          IF NOT FOUND THEN
            INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,display_value,validation_status,is_primary)
              VALUES(v_tenant,v_caller.contact_id,'whatsapp',v_caller.normalized_value,v_caller.normalized_value,'unverified',false)
              RETURNING * INTO v_whatsapp;
          END IF;
        END IF;
        SELECT * INTO v_channel FROM messaging.channels WHERE tenant_id=v_tenant AND kind='whatsapp' AND status='active' AND provider IN ('meta','simulator')
          ORDER BY CASE provider WHEN 'meta' THEN 0 ELSE 1 END,created_at,id LIMIT 1;
        IF NOT FOUND THEN RETURN jsonb_build_object('status','no_channel'); END IF;
        INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id,status)
          VALUES(v_tenant,v_channel.id,v_caller.contact_id,'open') ON CONFLICT (tenant_id,channel_id,contact_id) DO NOTHING;
        SELECT id,removed_from_inbox_at INTO v_conversation,v_removed FROM messaging.conversations WHERE tenant_id=v_tenant AND channel_id=v_channel.id AND contact_id=v_caller.contact_id;
        IF v_removed IS NOT NULL THEN RETURN jsonb_build_object('status','no_channel','reason','conversation_removed'); END IF;
        UPDATE service.intake_drafts SET conversation_id=coalesce(conversation_id,v_conversation),updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=p_intake;
        INSERT INTO service.case_conversations(tenant_id,case_id,conversation_id,relationship)
          SELECT v_tenant,id,v_conversation,'intake' FROM service.cases WHERE tenant_id=v_tenant AND intake_draft_id=p_intake ON CONFLICT DO NOTHING;
        UPDATE support.tickets SET source_conversation_id=coalesce(source_conversation_id,v_conversation) WHERE tenant_id=v_tenant AND intake_draft_id=p_intake;
        RETURN jsonb_build_object('status','ready','conversationId',v_conversation,'channelId',v_channel.id,'provider',v_channel.provider,
          'channelConfiguration',v_channel.configuration,'recipientIdentityId',v_whatsapp.id,'recipientAddress',v_whatsapp.normalized_value,
          'windowOpen',coalesce((SELECT customer_service_window_expires_at>clock_timestamp() FROM messaging.conversations WHERE tenant_id=v_tenant AND id=v_conversation),false));
      END $$;

      -- The outbound path's recipient check for a voice follow-up: the
      -- identity must be the pinned caller number (or its twin) of the intake
      -- on the conversation's contact.
      CREATE FUNCTION service.verified_followup_recipient(p_intake uuid,p_conversation uuid,p_identity uuid,p_address text) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT EXISTS(
          SELECT 1 FROM service.intake_drafts intake
          JOIN messaging.conversations conversation ON conversation.tenant_id=intake.tenant_id AND conversation.id=p_conversation
            AND conversation.contact_id=intake.reporting_contact_id AND conversation.removed_from_inbox_at IS NULL
          JOIN crm.contact_channel_identities caller ON caller.tenant_id=intake.tenant_id
            AND caller.id=service.voice_session_caller_identity(intake.tenant_id,intake.source_session_id)
          JOIN crm.contact_channel_identities recipient ON recipient.tenant_id=intake.tenant_id AND recipient.id=p_identity
            AND recipient.contact_id=conversation.contact_id AND recipient.channel='whatsapp'
            AND recipient.validation_status NOT IN ('invalid','revoked') AND recipient.normalized_value=caller.normalized_value
          WHERE intake.tenant_id=platform.current_tenant_id() AND intake.id=p_intake AND recipient.normalized_value=p_address)
      $$;

      CREATE FUNCTION service.record_intake_followup(p_intake uuid,p_status text,p_message uuid,p_error text) RETURNS void
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_ticket uuid;
      BEGIN
        IF p_status NOT IN ('admitted','blocked_consent','blocked_window','no_channel','no_recipient','recipient_conflict','failed') THEN
          RAISE EXCEPTION 'unsupported follow-up status' USING ERRCODE='22023'; END IF;
        UPDATE service.intake_drafts SET followup_status=p_status,followup_message_id=coalesce(p_message,followup_message_id),
          followup_error_safe=left(p_error,200),updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=p_intake;
        IF p_message IS NOT NULL THEN
          -- The follow-up message joins the intake so a WhatsApp reply to it
          -- correlates through the provider's stable message reference.
          INSERT INTO service.intake_messages(tenant_id,intake_draft_id,message_id) VALUES(v_tenant,p_intake,p_message) ON CONFLICT DO NOTHING;
        END IF;
        SELECT id INTO v_ticket FROM support.tickets WHERE tenant_id=v_tenant AND intake_draft_id=p_intake AND status='open';
        IF v_ticket IS NOT NULL THEN
          PERFORM support.append_ticket_event(v_tenant,v_ticket,'agent_message','system',
            CASE p_status WHEN 'admitted' THEN 'WhatsApp follow-up admitted for delivery; delivery status follows provider callbacks.'
              WHEN 'blocked_consent' THEN 'WhatsApp follow-up not sent: the customer has not consented.'
              WHEN 'blocked_window' THEN 'WhatsApp follow-up not sent: outside the customer-service window and no approved template is configured.'
              WHEN 'no_channel' THEN 'WhatsApp follow-up not sent: no active WhatsApp channel or sender is available.'
              WHEN 'no_recipient' THEN 'WhatsApp follow-up not sent: no verified caller number is available.'
              WHEN 'recipient_conflict' THEN 'WhatsApp follow-up not sent: the caller number belongs to another contact.'
              ELSE 'WhatsApp follow-up failed.' END,
            jsonb_strip_nulls(jsonb_build_object('followupStatus',p_status,'messageId',p_message,'error',left(p_error,200))));
          IF p_status<>'admitted' THEN
            UPDATE support.tickets SET next_action=coalesce(next_action,'contact_customer'),next_action_due_at=coalesce(next_action_due_at,clock_timestamp())
              WHERE tenant_id=v_tenant AND id=v_ticket;
          ELSE
            UPDATE support.tickets SET stage=CASE WHEN stage IN ('new','ai_handling','awaiting_human') AND service_case_id IS NULL THEN 'awaiting_customer' ELSE stage END
              WHERE tenant_id=v_tenant AND id=v_ticket;
          END IF;
        END IF;
      END $$;
    """)


def _correlation() -> None:
    _execute(f"""
      -- Attach one inbound message to one intake: evidence link, reply
      -- timestamps, inquiry timeline and (for an opened case) the case's
      -- customer evidence. Idempotent.
      CREATE FUNCTION service.attach_message_to_intake(p_tenant uuid,p_message uuid,p_intake uuid) RETURNS boolean
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_message messaging.messages%ROWTYPE; v_case uuid; v_ticket uuid; v_inserted integer;
      BEGIN
        SELECT * INTO v_message FROM messaging.messages WHERE tenant_id=p_tenant AND id=p_message AND direction='inbound';
        IF NOT FOUND THEN RETURN false; END IF;
        INSERT INTO service.intake_messages(tenant_id,intake_draft_id,message_id) VALUES(p_tenant,p_intake,p_message) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted>0 THEN
          UPDATE service.intake_drafts SET customer_replied_at=coalesce(customer_replied_at,clock_timestamp()),
            customer_media_received_at=CASE WHEN v_message.content_type IN ('image','document') THEN coalesce(customer_media_received_at,clock_timestamp()) ELSE customer_media_received_at END,
            last_message_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=p_tenant AND id=p_intake;
          SELECT id INTO v_ticket FROM support.tickets WHERE tenant_id=p_tenant AND intake_draft_id=p_intake AND status='open';
          IF v_ticket IS NOT NULL THEN
            PERFORM support.append_ticket_event(p_tenant,v_ticket,'customer_message','customer',
              CASE v_message.content_type WHEN 'image' THEN 'Customer sent a photo on WhatsApp.' WHEN 'document' THEN 'Customer sent a document on WhatsApp.'
                WHEN 'location' THEN 'Customer sent a location on WhatsApp.' ELSE 'Customer replied on WhatsApp.' END,
              jsonb_build_object('messageId',p_message,'contentType',v_message.content_type,'intakeId',p_intake));
            UPDATE support.tickets SET stage=CASE WHEN stage='awaiting_customer' THEN 'awaiting_human' ELSE stage END WHERE tenant_id=p_tenant AND id=v_ticket;
          END IF;
        END IF;
        SELECT id INTO v_case FROM service.cases WHERE tenant_id=p_tenant AND intake_draft_id=p_intake AND status NOT IN ('closed','cancelled');
        IF v_case IS NOT NULL AND v_message.content_type IN ('image','document') AND v_message.object_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM objects.object_metadata WHERE tenant_id=p_tenant AND id=v_message.object_id AND status='available' AND deleted_at IS NULL) THEN
          INSERT INTO service.report_attachments(tenant_id,case_id,message_id,object_id,category,source,processing_status)
          VALUES(p_tenant,v_case,p_message,v_message.object_id,CASE WHEN v_message.content_type='image' THEN 'customer_photo' ELSE 'document' END,'customer','available') ON CONFLICT DO NOTHING;
        END IF;
        RETURN true;
      END $$;

      CREATE OR REPLACE FUNCTION service.attach_followup_evidence() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_intake uuid; v_candidates integer; v_ids uuid[];
      BEGIN
        IF NEW.direction<>'inbound' OR NEW.content_type NOT IN ('text','image','document','location') THEN RETURN NEW; END IF;
        IF NEW.content_type IN ('image','document') AND NEW.object_id IS NULL AND TG_OP='UPDATE' THEN RETURN NEW; END IF;
        -- 1. The customer replied to our follow-up: a stable provider reference.
        IF NEW.reply_to_message_id IS NOT NULL THEN
          SELECT im.intake_draft_id INTO v_intake FROM service.intake_messages im
            JOIN service.intake_drafts d ON d.tenant_id=im.tenant_id AND d.id=im.intake_draft_id
            WHERE im.tenant_id=NEW.tenant_id AND im.message_id=NEW.reply_to_message_id AND d.status IN {OPEN_INTAKE}
            ORDER BY im.observed_at LIMIT 1;
        END IF;
        -- 2. Otherwise exactly one recent open intake on this conversation.
        IF v_intake IS NULL THEN
          SELECT count(*),array_agg(d.id ORDER BY d.updated_at DESC,d.id) INTO v_candidates,v_ids FROM service.intake_drafts d
            WHERE d.tenant_id=NEW.tenant_id AND d.conversation_id=NEW.conversation_id
              AND d.status IN {OPEN_INTAKE} AND d.updated_at>CURRENT_TIMESTAMP-interval '7 days';
          IF v_candidates=0 THEN RETURN NEW; END IF;
          IF v_candidates>1 THEN
            -- Never attach by recency: hold it for a person, but only when a
            -- voice follow-up is involved, preserving the WhatsApp-only intake
            -- behaviour that links by its own extraction job.
            IF EXISTS(SELECT 1 FROM service.intake_drafts WHERE tenant_id=NEW.tenant_id AND id=ANY(v_ids) AND followup_status<>'not_requested') THEN
              INSERT INTO service.followup_triage(tenant_id,message_id,candidate_intake_ids) VALUES(NEW.tenant_id,NEW.id,v_ids[1:50]) ON CONFLICT DO NOTHING;
            END IF;
            RETURN NEW;
          END IF;
          v_intake:=v_ids[1];
          -- A WhatsApp-originated intake keeps its existing behaviour: its own
          -- extraction job links text, this trigger links media only.
          IF NEW.content_type IN ('text','location') AND NOT EXISTS(SELECT 1 FROM service.intake_drafts WHERE tenant_id=NEW.tenant_id AND id=v_intake AND source_session_id IS NOT NULL) THEN
            RETURN NEW;
          END IF;
        END IF;
        PERFORM service.attach_message_to_intake(NEW.tenant_id,NEW.id,v_intake);
        RETURN NEW;
      END $$;

      CREATE FUNCTION service.resolve_followup_triage(p_message uuid,p_intake uuid) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_triage service.followup_triage%ROWTYPE;
      BEGIN
        IF coalesce(current_setting('app.current_role',true),'') NOT IN ('owner','admin','agent') OR platform.current_user_id() IS NULL THEN
          RAISE EXCEPTION 'staff access required' USING ERRCODE='42501'; END IF;
        SELECT * INTO v_triage FROM service.followup_triage WHERE tenant_id=v_tenant AND message_id=p_message FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'nothing to link' USING ERRCODE='P0002'; END IF;
        IF v_triage.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'already linked' USING ERRCODE='23505'; END IF;
        IF NOT p_intake=ANY(v_triage.candidate_intake_ids) THEN RAISE EXCEPTION 'choose one of the candidate inquiries' USING ERRCODE='22023'; END IF;
        PERFORM service.attach_message_to_intake(v_tenant,p_message,p_intake);
        UPDATE service.followup_triage SET resolved_intake_id=p_intake,resolved_by_user_id=platform.current_user_id(),resolved_at=clock_timestamp()
          WHERE tenant_id=v_tenant AND id=v_triage.id;
        INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
          VALUES(v_tenant,platform.current_user_id(),'field_service.followup.linked','intake_draft',p_intake,jsonb_build_object('messageId',p_message));
        RETURN jsonb_build_object('messageId',p_message,'intakeId',p_intake);
      END $$;

      -- A case opened from an intake carries the intake to its ticket.
      CREATE FUNCTION service.link_case_ticket_intake() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        IF NEW.intake_draft_id IS NOT NULL THEN
          UPDATE support.tickets SET intake_draft_id=NEW.intake_draft_id
            WHERE tenant_id=NEW.tenant_id AND service_case_id=NEW.id AND intake_draft_id IS NULL
              AND NOT EXISTS(SELECT 1 FROM support.tickets other WHERE other.tenant_id=NEW.tenant_id AND other.intake_draft_id=NEW.intake_draft_id);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER service_case_ticket_intake AFTER INSERT ON service.cases FOR EACH ROW EXECUTE FUNCTION service.link_case_ticket_intake();
    """)


def _settlement() -> None:
    _execute(f"""
      -- The call's end gives every early inquiry an explicit disposition,
      -- whoever ended it: the agent, the caller, a webhook or the stale-session
      -- sweeper. Uses the row's tenant, never request context.
      CREATE FUNCTION service.settle_voice_inquiry() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_intake service.intake_drafts%ROWTYPE; v_ticket support.tickets%ROWTYPE; v_case uuid; v_missing jsonb; v_policy jsonb;
        v_consent text; v_identity uuid;
      BEGIN
        IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN RETURN NEW; END IF;
        SELECT * INTO v_ticket FROM support.tickets WHERE tenant_id=NEW.tenant_id AND attachment_key='voice-session:'||NEW.session_id::text FOR UPDATE;
        SELECT * INTO v_intake FROM service.intake_drafts WHERE tenant_id=NEW.tenant_id AND source_session_id=NEW.session_id FOR UPDATE;
        IF v_intake.id IS NOT NULL THEN
          SELECT id INTO v_case FROM service.cases WHERE tenant_id=NEW.tenant_id AND intake_draft_id=v_intake.id;
          v_policy:=coalesce(v_intake.workflow_policy,'{{}}'::jsonb);
          v_missing:=service.intake_missing_fields(v_intake.collected_fields,v_policy);
        END IF;
        IF v_ticket.id IS NOT NULL AND v_ticket.status='open' THEN
          PERFORM support.append_ticket_event(NEW.tenant_id,v_ticket.id,'call_outcome','system',
            CASE WHEN v_case IS NOT NULL THEN 'Call ended. The service case was opened.'
              WHEN v_intake.id IS NULL THEN 'Call ended before any service details were saved. Follow up with the caller.'
              ELSE 'Call ended before the service details were confirmed. Follow up to complete the inquiry.' END,
            jsonb_strip_nulls(jsonb_build_object('sessionId',NEW.session_id,'status',NEW.status::text,'caseId',v_case,
              'missingFields',CASE WHEN v_case IS NULL THEN v_missing END)));
          UPDATE support.tickets SET stage=CASE WHEN stage IN ('new','ai_handling','in_call') THEN 'awaiting_human' ELSE stage END,
            handling_mode=CASE WHEN handling_mode='ai_voice' THEN 'human' ELSE handling_mode END,
            next_action=coalesce(next_action,CASE WHEN v_case IS NULL THEN 'complete_intake' ELSE 'dispatch' END),
            next_action_due_at=coalesce(next_action_due_at,clock_timestamp()),updated_at=clock_timestamp()
            WHERE tenant_id=NEW.tenant_id AND id=v_ticket.id;
        END IF;
        IF v_intake.id IS NOT NULL AND coalesce((v_policy#>>'{{whatsappFollowUp,enabled}}')::boolean,false) THEN
          IF v_intake.followup_status='requested' THEN
            PERFORM service.enqueue_intake_followup(NEW.tenant_id,v_intake.id,'call_ended');
          ELSIF v_intake.followup_status='not_requested' AND v_policy#>>'{{whatsappFollowUp,trigger}}'='call_ended' THEN
            -- Without an in-call request, only a customer who already granted
            -- WhatsApp consent receives the follow-up.
            SELECT whatsapp_consent INTO v_consent FROM crm.contacts WHERE tenant_id=NEW.tenant_id AND id=v_intake.reporting_contact_id AND whatsapp_opted_out_at IS NULL;
            v_identity:=service.voice_session_caller_identity(NEW.tenant_id,NEW.session_id);
            IF v_consent='granted' AND v_identity IS NOT NULL THEN
              PERFORM service.enqueue_intake_followup(NEW.tenant_id,v_intake.id,'call_ended');
            END IF;
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_settle_voice_inquiry AFTER UPDATE OF ended_at ON public.sessions
        FOR EACH ROW EXECUTE FUNCTION service.settle_voice_inquiry();
    """)


def _grants() -> None:
    for signature in (
        "support.append_ticket_event(uuid,uuid,text,text,text,jsonb)",
        "service.tenant_is_hebrew(uuid)",
        "service.voice_session_caller_identity(uuid,uuid)",
        "service.open_voice_inquiry(uuid)",
        "service.voice_session_event(uuid,uuid,text,jsonb)",
        "service.escalate_voice_emergency(uuid,text)",
        "service.voice_emergency_transfer(uuid)",
        "service.record_voice_escalation(uuid,text)",
        "service.enqueue_intake_followup(uuid,uuid,text)",
        "service.request_intake_followup(uuid,boolean)",
        "service.intake_followup_plan(uuid)",
        "service.prepare_intake_followup_recipient(uuid)",
        "service.verified_followup_recipient(uuid,uuid,uuid,text)",
        "service.record_intake_followup(uuid,text,uuid,text)",
        "service.attach_message_to_intake(uuid,uuid,uuid)",
        "service.resolve_followup_triage(uuid,uuid)",
        "service.link_case_ticket_intake()",
        "service.settle_voice_inquiry()",
    ):
        _execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
    _execute(
        "GRANT EXECUTE ON FUNCTION service.open_voice_inquiry(uuid),service.escalate_voice_emergency(uuid,text),"
        "service.voice_emergency_transfer(uuid),service.record_voice_escalation(uuid,text),"
        "service.request_intake_followup(uuid,boolean) TO platform_voice"
    )
    _execute(
        "GRANT EXECUTE ON FUNCTION service.intake_followup_plan(uuid),service.prepare_intake_followup_recipient(uuid),"
        "service.verified_followup_recipient(uuid,uuid,uuid,text),service.record_intake_followup(uuid,text,uuid,text) TO platform_messaging"
    )
    _execute("GRANT EXECUTE ON FUNCTION service.resolve_followup_triage(uuid,uuid) TO platform_web")
    _execute("GRANT SELECT ON service.followup_triage TO platform_web,platform_readonly")


def downgrade() -> None:
    _restore_previous_intake_functions()
    _execute("DROP TRIGGER IF EXISTS trg_settle_voice_inquiry ON public.sessions")
    _execute("DROP TRIGGER IF EXISTS service_case_ticket_intake ON service.cases")
    for signature in (
        "service.settle_voice_inquiry()",
        "service.link_case_ticket_intake()",
        "service.resolve_followup_triage(uuid,uuid)",
        "service.record_intake_followup(uuid,text,uuid,text)",
        "service.verified_followup_recipient(uuid,uuid,uuid,text)",
        "service.prepare_intake_followup_recipient(uuid)",
        "service.intake_followup_plan(uuid)",
        "service.request_intake_followup(uuid,boolean)",
        "service.enqueue_intake_followup(uuid,uuid,text)",
        "service.record_voice_escalation(uuid,text)",
        "service.voice_emergency_transfer(uuid)",
        "service.escalate_voice_emergency(uuid,text)",
        "service.voice_session_event(uuid,uuid,text,jsonb)",
        "service.open_voice_inquiry(uuid)",
        "service.voice_session_caller_identity(uuid,uuid)",
        "service.tenant_is_hebrew(uuid)",
        "support.append_ticket_event(uuid,uuid,text,text,text,jsonb)",
    ):
        _execute(f"DROP FUNCTION IF EXISTS {signature}")
    # attach_message_to_intake is referenced by the replaced trigger function;
    # restore the previous media-only trigger body before dropping it.
    _execute(f"""
      CREATE OR REPLACE FUNCTION service.attach_followup_evidence() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_case uuid; v_intake uuid; v_candidates integer;
      BEGIN
        IF NEW.direction<>'inbound' OR NEW.content_type NOT IN ('image','document') OR NEW.object_id IS NULL THEN RETURN NEW; END IF;
        SELECT count(*),(array_agg(d.id))[1] INTO v_candidates,v_intake FROM service.intake_drafts d WHERE d.tenant_id=NEW.tenant_id AND d.conversation_id=NEW.conversation_id
          AND d.status IN {OPEN_INTAKE} AND d.updated_at>CURRENT_TIMESTAMP-interval '7 days';
        IF v_candidates<>1 THEN RETURN NEW; END IF;
        INSERT INTO service.intake_messages(tenant_id,intake_draft_id,message_id) VALUES(NEW.tenant_id,v_intake,NEW.id) ON CONFLICT DO NOTHING;
        SELECT id INTO v_case FROM service.cases WHERE tenant_id=NEW.tenant_id AND intake_draft_id=v_intake AND status NOT IN ('closed','cancelled');
        IF v_case IS NOT NULL AND EXISTS(SELECT 1 FROM objects.object_metadata WHERE tenant_id=NEW.tenant_id AND id=NEW.object_id AND status='available' AND deleted_at IS NULL) THEN
          INSERT INTO service.report_attachments(tenant_id,case_id,message_id,object_id,category,source,processing_status)
          VALUES(NEW.tenant_id,v_case,NEW.id,NEW.object_id,CASE WHEN NEW.content_type='image' THEN 'customer_photo' ELSE 'document' END,'customer','available') ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END $$
    """)
    _execute("DROP FUNCTION IF EXISTS service.attach_message_to_intake(uuid,uuid,uuid)")
    _execute("DROP TABLE service.followup_triage")
    _execute(
        "ALTER TABLE service.intake_drafts DROP CONSTRAINT fk_intake_followup_message,"
        " DROP CONSTRAINT ck_intake_followup_error, DROP CONSTRAINT ck_intake_followup_status,"
        " DROP COLUMN customer_media_received_at, DROP COLUMN customer_replied_at, DROP COLUMN followup_error_safe,"
        " DROP COLUMN followup_message_id, DROP COLUMN followup_requested_at, DROP COLUMN followup_status"
    )
    _execute("DROP INDEX IF EXISTS support.uq_support_ticket_intake")
    _execute(
        "ALTER TABLE support.tickets DROP CONSTRAINT fk_support_ticket_intake, DROP COLUMN intake_draft_id"
    )
    _execute("UPDATE ops.inbound_events SET status='processed' WHERE status='quarantined'")
    _execute("ALTER TABLE ops.inbound_events DROP CONSTRAINT ck_inbound_event_status")
    _execute(
        "ALTER TABLE ops.inbound_events ADD CONSTRAINT ck_inbound_event_status"
        " CHECK (status IN ('received','processing','processed','failed','ignored'))"
    )


def _restore_previous_intake_functions() -> None:
    # Restore the previous revision's capture and photo-request bodies exactly;
    # the replaced versions call functions this downgrade removes.
    _execute("""
      CREATE OR REPLACE FUNCTION service.capture_service_intake(p_session uuid,p_fields jsonb,p_confirmed boolean) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_context jsonb; v_tenant uuid:=platform.current_tenant_id(); v_contact uuid; v_fields jsonb; v_policy jsonb;
        v_intake uuid; v_case uuid; v_location uuid; v_chain uuid; v_key text; v_value jsonb; v_missing jsonb; v_reference text; v_conversation uuid;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text||':voice-service:'||p_session::text,0));
        v_context:=service.voice_intake_context(p_session);
        IF v_context->>'status'='identity_required' THEN RAISE EXCEPTION 'verify caller identity first' USING ERRCODE='42501'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session AND ended_at IS NULL)
          OR EXISTS(SELECT 1 FROM public.voice_session_controls WHERE tenant_id=v_tenant AND session_id=p_session AND desired_mode<>'ai') THEN
          RAISE EXCEPTION 'voice conversation no longer permits agent actions' USING ERRCODE='42501'; END IF;
        IF v_context->>'caseId' IS NOT NULL THEN RETURN v_context; END IF;
        IF jsonb_typeof(p_fields) IS DISTINCT FROM 'object' OR octet_length(p_fields::text)>16384 THEN RAISE EXCEPTION 'invalid intake fields' USING ERRCODE='22023'; END IF;
        v_fields:=v_context->'knownFields'; v_policy:=v_context->'policy';
        FOR v_key,v_value IN SELECT key,value FROM jsonb_each(p_fields) LOOP
          IF v_key NOT IN ('customerName','chainName','storeName','storeId','serviceAddress','faultDescription','exactFailure','productType','productModel','serialNumber','warrantyStatus') OR jsonb_typeof(v_value)<>'string' THEN
            RAISE EXCEPTION 'unsupported intake field' USING ERRCODE='22023'; END IF;
          IF length(btrim(v_value#>>'{}'))>(CASE WHEN v_key='faultDescription' THEN 10000 WHEN v_key='exactFailure' THEN 2000 WHEN v_key='serviceAddress' THEN 500 ELSE 160 END) THEN RAISE EXCEPTION 'intake field too long' USING ERRCODE='22023'; END IF;
          IF nullif(btrim(v_value#>>'{}'),'') IS NOT NULL THEN v_fields:=v_fields||jsonb_build_object(v_key,btrim(v_value#>>'{}')); END IF;
        END LOOP;
        IF v_fields->>'storeId' IS NOT NULL THEN
          SELECT location.id,location.chain_id INTO v_location,v_chain FROM crm.service_locations location WHERE location.tenant_id=v_tenant AND location.id=(v_fields->>'storeId')::uuid AND location.archived_at IS NULL;
          IF v_location IS NULL THEN RAISE EXCEPTION 'store is not in tenant directory' USING ERRCODE='22023'; END IF;
          SELECT v_fields||jsonb_strip_nulls(jsonb_build_object('storeName',location.name,'serviceAddress',location.address,'chainName',chain.name)) INTO v_fields
            FROM crm.service_locations location LEFT JOIN crm.service_chains chain ON chain.tenant_id=location.tenant_id AND chain.id=location.chain_id WHERE location.tenant_id=v_tenant AND location.id=v_location;
        END IF;
        SELECT contact_id INTO v_contact FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session;
        v_missing:=service.intake_missing_fields(v_fields,v_policy);
        IF p_fields->>'customerName' IS NOT NULL THEN
          UPDATE crm.contacts SET name=v_fields->>'customerName',updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND id=v_contact AND name ~ '^\\+?[0-9 ()-]{7,}$';
        END IF;
        INSERT INTO service.intake_drafts(tenant_id,source_session_id,reporting_contact_id,customer_contact_id,customer_resolution_status,correlation_key,collected_fields,status)
        VALUES(v_tenant,p_session,v_contact,v_contact,'reporting_contact','voice:'||p_session::text,v_fields,CASE WHEN jsonb_array_length(v_missing)=0 THEN 'awaiting_confirmation' ELSE 'collecting' END)
        ON CONFLICT(tenant_id,source_session_id) WHERE source_session_id IS NOT NULL DO UPDATE SET collected_fields=EXCLUDED.collected_fields,status=EXCLUDED.status,updated_at=CURRENT_TIMESTAMP RETURNING id INTO v_intake;
        UPDATE service.intake_drafts SET workflow_policy=v_policy WHERE tenant_id=v_tenant AND id=v_intake;
        IF NOT coalesce(p_confirmed,false) OR jsonb_array_length(v_missing)>0 THEN RETURN service.voice_intake_context(p_session); END IF;
        IF v_policy->>'photoPolicy'='required' AND NOT EXISTS(SELECT 1 FROM service.intake_messages im JOIN messaging.messages m ON m.tenant_id=im.tenant_id AND m.id=im.message_id JOIN objects.object_metadata o ON o.tenant_id=m.tenant_id AND o.id=m.object_id WHERE im.tenant_id=v_tenant AND im.intake_draft_id=v_intake AND m.content_type='image' AND o.status='available' AND o.deleted_at IS NULL) THEN
          RETURN service.voice_intake_context(p_session)||jsonb_build_object('missingFields',v_missing||'["photos"]'::jsonb);
        END IF;
        IF v_location IS NULL AND v_fields->>'storeName' IS NOT NULL THEN
          IF v_fields->>'chainName' IS NOT NULL THEN
            SELECT id INTO v_chain FROM crm.service_chains WHERE tenant_id=v_tenant AND lower(name)=lower(v_fields->>'chainName') AND active;
            IF v_chain IS NULL THEN INSERT INTO crm.service_chains(tenant_id,name) VALUES(v_tenant,v_fields->>'chainName') ON CONFLICT(tenant_id,lower(name)) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO v_chain; END IF;
          END IF;
          SELECT id INTO v_location FROM crm.service_locations WHERE tenant_id=v_tenant AND chain_id IS NOT DISTINCT FROM v_chain AND lower(name)=lower(v_fields->>'storeName') AND archived_at IS NULL ORDER BY id LIMIT 1;
          IF v_location IS NULL THEN INSERT INTO crm.service_locations(tenant_id,customer_contact_id,chain_id,name,address) VALUES(v_tenant,v_contact,v_chain,v_fields->>'storeName',v_fields->>'serviceAddress') RETURNING id INTO v_location; END IF;
        END IF;
        v_case:=gen_random_uuid(); v_reference:='FS-'||to_char(CURRENT_TIMESTAMP,'YYYY')||'-'||upper(left(replace(v_case::text,'-',''),8));
        SELECT conversation_id INTO v_conversation FROM service.intake_drafts WHERE tenant_id=v_tenant AND id=v_intake;
        INSERT INTO service.cases(id,tenant_id,reference,customer_contact_id,reporting_contact_id,service_location_id,intake_draft_id,conversation_id,title,fault_description,product_type,product_model,serial_number,source)
        VALUES(v_case,v_tenant,v_reference,v_contact,v_contact,v_location,v_intake,v_conversation,left(v_fields->>'faultDescription',200),left((v_fields->>'faultDescription')||CASE WHEN v_fields->>'exactFailure' IS NULL THEN '' ELSE E'\\n'||(v_fields->>'exactFailure') END,10000),v_fields->>'productType',v_fields->>'productModel',v_fields->>'serialNumber','voice');
        UPDATE service.cases SET workflow_policy=v_policy WHERE tenant_id=v_tenant AND id=v_case;
        INSERT INTO service.case_calls(tenant_id,case_id,session_id,relationship) VALUES(v_tenant,v_case,p_session,'intake');
        IF v_conversation IS NOT NULL THEN INSERT INTO service.case_conversations(tenant_id,case_id,conversation_id,relationship) VALUES(v_tenant,v_case,v_conversation,'intake') ON CONFLICT DO NOTHING; END IF;
        INSERT INTO service.report_attachments(tenant_id,case_id,message_id,object_id,category,source,processing_status)
          SELECT v_tenant,v_case,m.id,m.object_id,CASE WHEN m.content_type='image' THEN 'customer_photo' ELSE 'document' END,'customer','available'
          FROM service.intake_messages im JOIN messaging.messages m ON m.tenant_id=im.tenant_id AND m.id=im.message_id
          JOIN objects.object_metadata o ON o.tenant_id=m.tenant_id AND o.id=m.object_id
          WHERE im.tenant_id=v_tenant AND im.intake_draft_id=v_intake AND m.content_type IN ('image','document') AND o.status='available' AND o.deleted_at IS NULL ON CONFLICT DO NOTHING;
        INSERT INTO service.case_status_history(tenant_id,case_id,to_status,actor_service) VALUES(v_tenant,v_case,'awaiting_scheduling','voice-intake');
        UPDATE service.intake_drafts SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND id=v_intake;
        INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata) VALUES(v_tenant,'voice-intake','field_service.intake.confirmed','service_case',v_case,jsonb_build_object('sessionId',p_session,'intakeId',v_intake));
        RETURN service.voice_intake_context(p_session);
      END $$;
      CREATE OR REPLACE FUNCTION service.request_voice_intake_photos(p_session uuid,p_message text) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_context jsonb; v_contact uuid; v_conversations uuid[]; v_conversation uuid; v_job uuid; v_tenant uuid:=platform.current_tenant_id();
      BEGIN
        v_context:=service.voice_intake_context(p_session);
        IF v_context->>'status'='identity_required' OR NOT EXISTS(SELECT 1 FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session AND ended_at IS NULL)
          OR EXISTS(SELECT 1 FROM public.voice_session_controls WHERE tenant_id=v_tenant AND session_id=p_session AND desired_mode<>'ai') THEN
          RAISE EXCEPTION 'voice conversation no longer permits agent actions' USING ERRCODE='42501'; END IF;
        IF v_context->>'intakeId' IS NULL THEN RAISE EXCEPTION 'intake must be saved before requesting photos' USING ERRCODE='22023'; END IF;
        IF char_length(btrim(coalesce(p_message,''))) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'invalid photo request' USING ERRCODE='22023'; END IF;
        IF NOT platform.current_tenant_feature_enabled('whatsapp') THEN RETURN jsonb_build_object('status','unavailable','reason','whatsapp_disabled'); END IF;
        SELECT contact_id INTO v_contact FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session;
        SELECT array_agg(c.id) INTO v_conversations FROM messaging.conversations c JOIN messaging.channels channel ON channel.tenant_id=c.tenant_id AND channel.id=c.channel_id
          JOIN crm.contacts contact ON contact.tenant_id=c.tenant_id AND contact.id=c.contact_id
          WHERE c.tenant_id=v_tenant AND c.contact_id=v_contact AND c.removed_from_inbox_at IS NULL
            AND c.ownership_mode='ai' AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
            AND channel.kind='whatsapp' AND channel.status='active' AND c.customer_service_window_expires_at>CURRENT_TIMESTAMP
            AND contact.lifecycle_status='active' AND contact.whatsapp_consent='granted' AND contact.whatsapp_opted_out_at IS NULL;
        IF coalesce(array_length(v_conversations,1),0)<>1 THEN RETURN jsonb_build_object('status','unavailable','reason','send_a_whatsapp_message_first'); END IF;
        v_conversation:=v_conversations[1];
        UPDATE service.intake_drafts SET conversation_id=v_conversation WHERE tenant_id=v_tenant AND id=(v_context->>'intakeId')::uuid;
        IF v_context->>'caseId' IS NOT NULL THEN
          INSERT INTO service.case_conversations(tenant_id,case_id,conversation_id,relationship) VALUES(v_tenant,(v_context->>'caseId')::uuid,v_conversation,'intake') ON CONFLICT DO NOTHING;
        END IF;
        INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts)
        VALUES(v_tenant,'messaging','field_service.photo_request','intake_draft',(v_context->>'intakeId')::uuid,jsonb_build_object('conversationId',v_conversation,'text',btrim(p_message)), 'service-photo:'||p_session::text,3)
        ON CONFLICT DO NOTHING RETURNING id INTO v_job;
        IF v_job IS NULL THEN SELECT id INTO v_job FROM ops.jobs WHERE tenant_id=v_tenant AND idempotency_key='service-photo:'||p_session::text; END IF;
        RETURN jsonb_build_object('status','queued','jobId',v_job,'intakeId',v_context->>'intakeId','caseId',v_context->>'caseId');
      END $$
    """)
