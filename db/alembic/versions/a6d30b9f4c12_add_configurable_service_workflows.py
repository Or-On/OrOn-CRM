"""Configurable service intake, retail directory and atomic technician dispatch.

Revision ID: a6d30b9f4c12
Revises: f4c8a2d91e70
"""

# ruff: noqa: E501, S608 -- SQL uses migration-owned constants only.
from collections.abc import Sequence

from alembic import op

revision: str = "a6d30b9f4c12"
down_revision: str | None = "f4c8a2d91e70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LEGACY_POLICY = '{"version":1,"requiredIntakeFields":["customerName","customerPhone","nationalId","storeName","serviceLocation","faultDescription","warrantyStatus"],"photoPolicy":"optional","selfAssignmentEnabled":false,"requiredReportFields":["diagnosis","workPerformed","partReplaced","arrivalSignature","departureSignature","faultPhoto","modulePhoto"]}'


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
    _execute("""
      CREATE TABLE crm.service_chains (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
        name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 160),
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id,id)
      );
      CREATE UNIQUE INDEX uq_service_chain_name ON crm.service_chains(tenant_id,lower(name));
      ALTER TABLE crm.service_chains ENABLE ROW LEVEL SECURITY;
      ALTER TABLE crm.service_chains FORCE ROW LEVEL SECURITY;
      CREATE POLICY service_chains_tenant ON crm.service_chains
        USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
      CREATE POLICY service_chains_read_scope ON crm.service_chains AS RESTRICTIVE
        USING(coalesce(current_setting('app.current_role',true),'')<>'technician')
        WITH CHECK(coalesce(current_setting('app.current_role',true),'') IN ('owner','admin'));
      GRANT SELECT,INSERT,UPDATE ON crm.service_chains TO platform_web;
      GRANT SELECT ON crm.service_chains TO platform_messaging,platform_worker;
      ALTER TABLE crm.service_locations ADD COLUMN chain_id uuid,
        ADD FOREIGN KEY(tenant_id,chain_id) REFERENCES crm.service_chains(tenant_id,id) ON DELETE RESTRICT;
      ALTER TABLE service.intake_drafts ALTER COLUMN conversation_id DROP NOT NULL,
        ADD COLUMN source_session_id uuid,
        ADD COLUMN workflow_policy jsonb,
        ADD FOREIGN KEY(tenant_id,source_session_id) REFERENCES public.sessions(tenant_id,session_id) ON DELETE RESTRICT;
      ALTER TABLE service.cases ADD COLUMN assigned_technician_id uuid,
        ADD COLUMN workflow_policy jsonb,
        ADD FOREIGN KEY(tenant_id,assigned_technician_id) REFERENCES service.technicians(tenant_id,id) ON DELETE RESTRICT;
      ALTER TABLE service.cases DROP CONSTRAINT ck_service_case_source;
      ALTER TABLE service.cases ADD CONSTRAINT ck_service_case_source CHECK(source IN ('manual','whatsapp','voice'));
      CREATE UNIQUE INDEX uq_service_intake_voice ON service.intake_drafts(tenant_id,source_session_id) WHERE source_session_id IS NOT NULL;
    """)
    _execute(f"""
      CREATE FUNCTION service.current_workflow_policy() RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT coalesce((SELECT configuration->'workflow' FROM platform.tenant_feature_entitlements
          WHERE tenant_id=platform.current_tenant_id() AND feature_key='field_service'),'{LEGACY_POLICY}'::jsonb)
      $$;
      CREATE FUNCTION service.pin_intake_workflow() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        SELECT coalesce((SELECT configuration->'workflow' FROM platform.tenant_feature_entitlements WHERE tenant_id=NEW.tenant_id AND feature_key='field_service'),'{LEGACY_POLICY}'::jsonb) INTO NEW.workflow_policy;
        IF TG_TABLE_NAME='cases' THEN
          IF NEW.intake_draft_id IS NOT NULL THEN
            SELECT coalesce(workflow_policy,'{LEGACY_POLICY}'::jsonb) INTO NEW.workflow_policy FROM service.intake_drafts WHERE tenant_id=NEW.tenant_id AND id=NEW.intake_draft_id;
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER service_intake_policy BEFORE INSERT ON service.intake_drafts
        FOR EACH ROW EXECUTE FUNCTION service.pin_intake_workflow();
      CREATE TRIGGER service_case_policy BEFORE INSERT ON service.cases
        FOR EACH ROW EXECUTE FUNCTION service.pin_intake_workflow();
    """)
    _execute("""
      CREATE FUNCTION service.validate_workflow_policy(p_policy jsonb) RETURNS boolean
      LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
      BEGIN
        IF p_policy IS NULL OR jsonb_typeof(p_policy)<>'object' THEN RETURN false; END IF;
        IF p_policy->>'version' IS DISTINCT FROM '1' OR jsonb_typeof(p_policy->'selfAssignmentEnabled') IS DISTINCT FROM 'boolean'
          OR coalesce(p_policy->>'photoPolicy','') NOT IN ('optional','requested','required')
          OR jsonb_typeof(p_policy->'requiredIntakeFields') IS DISTINCT FROM 'array'
          OR jsonb_typeof(p_policy->'requiredReportFields') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_policy) key WHERE key NOT IN ('version','selfAssignmentEnabled','photoPolicy','requiredIntakeFields','requiredReportFields')) THEN RETURN false; END IF;
        IF NOT (p_policy->'requiredIntakeFields' ? 'faultDescription') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_policy->'requiredIntakeFields') key WHERE key NOT IN ('customerName','customerPhone','nationalId','chainName','storeName','serviceLocation','faultDescription','exactFailure','warrantyStatus')) THEN RETURN false; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_policy->'requiredReportFields') key WHERE key NOT IN ('diagnosis','workPerformed','partReplaced','arrivalSignature','departureSignature','faultPhoto','modulePhoto')) THEN RETURN false; END IF;
        RETURN (SELECT count(*)=count(DISTINCT key) FROM jsonb_array_elements_text(p_policy->'requiredIntakeFields') key)
          AND (SELECT count(*)=count(DISTINCT key) FROM jsonb_array_elements_text(p_policy->'requiredReportFields') key);
      END $$;
      CREATE FUNCTION service.contact_intake_context(p_contact uuid) RETURNS jsonb
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_fields jsonb; v_options jsonb; v_phone text; v_tenant uuid:=platform.current_tenant_id();
      BEGIN
        IF NOT service.field_service_enabled() THEN RAISE EXCEPTION 'field service disabled' USING ERRCODE='42501'; END IF;
        SELECT jsonb_strip_nulls(jsonb_build_object('customerName',CASE WHEN name !~ '^\\+?[0-9 ()-]{7,}$' THEN name END)) INTO v_fields FROM crm.contacts WHERE tenant_id=v_tenant AND id=p_contact;
        IF v_fields IS NULL THEN RAISE EXCEPTION 'contact not found' USING ERRCODE='P0002'; END IF;
        SELECT normalized_value INTO v_phone FROM crm.contact_channel_identities WHERE tenant_id=v_tenant AND contact_id=p_contact AND channel IN ('phone','whatsapp') AND validation_status NOT IN ('invalid','revoked') ORDER BY is_primary DESC,created_at,id LIMIT 1;
        v_fields:=v_fields||jsonb_strip_nulls(jsonb_build_object('customerPhone',v_phone));
        SELECT coalesce(jsonb_agg(option),'[]'::jsonb) INTO v_options FROM (
          SELECT jsonb_strip_nulls(jsonb_build_object('storeId',l.id,'storeName',l.name,'chainName',c.name,'serviceAddress',l.address)) AS option
          FROM crm.service_locations l LEFT JOIN crm.service_chains c ON c.tenant_id=l.tenant_id AND c.id=l.chain_id
          WHERE l.tenant_id=v_tenant AND l.customer_contact_id=p_contact AND l.archived_at IS NULL ORDER BY l.name,l.id LIMIT 50
        ) options;
        IF jsonb_array_length(v_options)=1 THEN v_fields:=v_fields||(v_options->0); END IF;
        RETURN jsonb_build_object('knownFields',v_fields,'storeOptions',v_options);
      END $$;
      CREATE FUNCTION service.intake_missing_fields(p_fields jsonb,p_policy jsonb)
      RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
        SELECT coalesce(jsonb_agg(field),'[]'::jsonb)
        FROM jsonb_array_elements_text(p_policy->'requiredIntakeFields') field
        WHERE CASE field WHEN 'serviceLocation' THEN coalesce(nullif(btrim(p_fields->>'serviceAddress'),''),p_fields->>'storeId') IS NULL
          AND NOT(p_fields ? 'latitude' AND p_fields ? 'longitude')
        WHEN 'warrantyStatus' THEN coalesce(p_fields->>'warrantyStatus','unknown') NOT IN ('yes','no')
        ELSE nullif(btrim(p_fields->>field),'') IS NULL END
      $$;
      CREATE FUNCTION service.intake_has_photo(p_intake uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT EXISTS(SELECT 1 FROM service.intake_messages im JOIN messaging.messages m ON m.tenant_id=im.tenant_id AND m.id=im.message_id
          JOIN objects.object_metadata o ON o.tenant_id=m.tenant_id AND o.id=m.object_id
          WHERE im.tenant_id=platform.current_tenant_id() AND im.intake_draft_id=p_intake AND m.content_type='image' AND o.status='available' AND o.deleted_at IS NULL)
      $$;
      CREATE FUNCTION service.link_case_support_ticket() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_ticket uuid; v_key text; v_id uuid:=gen_random_uuid(); v_chain uuid; v_chain_name text;
      BEGIN
        IF NOT platform.tenant_feature_enabled_for(NEW.tenant_id,'tickets') THEN
          IF NEW.source IN ('whatsapp','voice') OR EXISTS(SELECT 1 FROM platform.tenant_feature_entitlements WHERE tenant_id=NEW.tenant_id AND feature_key='field_service' AND configuration ? 'workflow') THEN
            RAISE EXCEPTION 'configured service workflows require support tickets' USING ERRCODE='42501';
          END IF;
          RETURN NEW;
        END IF;
        -- Preserve a newly supplied chain in the directory across both channels.
        -- An existing selected store keeps its authoritative chain association.
        IF NEW.intake_draft_id IS NOT NULL AND NEW.service_location_id IS NOT NULL THEN
          SELECT left(nullif(btrim(collected_fields->>'chainName'),''),160) INTO v_chain_name FROM service.intake_drafts WHERE tenant_id=NEW.tenant_id AND id=NEW.intake_draft_id;
          IF v_chain_name IS NOT NULL AND EXISTS(SELECT 1 FROM crm.service_locations WHERE tenant_id=NEW.tenant_id AND id=NEW.service_location_id AND chain_id IS NULL) THEN
            INSERT INTO crm.service_chains(tenant_id,name) VALUES(NEW.tenant_id,v_chain_name)
              ON CONFLICT(tenant_id,lower(name)) DO UPDATE SET name=crm.service_chains.name RETURNING id INTO v_chain;
            UPDATE crm.service_locations SET chain_id=v_chain WHERE tenant_id=NEW.tenant_id AND id=NEW.service_location_id AND chain_id IS NULL;
          END IF;
        END IF;
        v_key := 'service-case:'||NEW.id::text;
        -- Reuse only a ticket carrying evidence from this exact intake or call.
        -- Conversation recency is not evidence that two requests are one issue.
        SELECT id INTO v_ticket FROM support.tickets WHERE tenant_id=NEW.tenant_id
          AND status='open' AND service_case_id IS NULL AND (
            EXISTS(SELECT 1 FROM support.ticket_events event JOIN service.intake_messages im
              ON im.tenant_id=event.tenant_id AND im.message_id::text=event.evidence->>'messageId'
              WHERE event.tenant_id=NEW.tenant_id AND event.ticket_id=support.tickets.id AND im.intake_draft_id=NEW.intake_draft_id)
            OR EXISTS(SELECT 1 FROM ops.jobs job JOIN service.intake_messages im
              ON im.tenant_id=job.tenant_id AND im.message_id::text=job.payload->>'triggerMessageId'
              WHERE job.tenant_id=NEW.tenant_id AND attachment_key='whatsapp-ai-issue:'||job.id::text AND im.intake_draft_id=NEW.intake_draft_id)
            OR EXISTS(SELECT 1 FROM support.ticket_call_attempts attempt JOIN service.intake_drafts draft
              ON draft.tenant_id=attempt.tenant_id AND draft.source_session_id=attempt.session_id
              WHERE attempt.tenant_id=NEW.tenant_id AND attempt.ticket_id=support.tickets.id AND draft.id=NEW.intake_draft_id)
            OR attachment_key=(SELECT 'voice-session:'||source_session_id::text FROM service.intake_drafts WHERE tenant_id=NEW.tenant_id AND id=NEW.intake_draft_id)
          )
          ORDER BY opened_at DESC,id DESC LIMIT 1 FOR UPDATE;
        IF v_ticket IS NULL THEN
          INSERT INTO support.tickets(id,tenant_id,reference,attachment_key,contact_id,subject,
            source_channel,source_conversation_id,service_case_id,stage,handling_mode,next_event_sequence)
          VALUES(v_id,NEW.tenant_id,'T-'||to_char(CURRENT_TIMESTAMP,'YYYY')||'-'||upper(left(replace(v_id::text,'-',''),8)),
            v_key,NEW.customer_contact_id,NEW.title,NEW.source,NEW.conversation_id,NEW.id,'awaiting_human','human',1)
          RETURNING id INTO v_ticket;
          INSERT INTO support.ticket_events(tenant_id,ticket_id,sequence,kind,actor_kind,visibility,summary_safe,evidence)
          VALUES(NEW.tenant_id,v_ticket,1,'opened','system','internal',left(NEW.fault_description,2000),jsonb_build_object('serviceCaseId',NEW.id));
        ELSE
          UPDATE support.tickets SET service_case_id=NEW.id,updated_at=CURRENT_TIMESTAMP WHERE id=v_ticket AND tenant_id=NEW.tenant_id;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER service_case_support_ticket AFTER INSERT ON service.cases FOR EACH ROW EXECUTE FUNCTION service.link_case_support_ticket();
    """)
    _execute("""
      CREATE FUNCTION service.list_assignment_queue(p_view text)
      RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_technician uuid; v_role text:=coalesce(current_setting('app.current_role',true),'');
      BEGIN
        IF NOT service.field_service_enabled() OR NOT platform.current_tenant_feature_enabled('technicians')
          OR NOT platform.current_tenant_active() OR v_role NOT IN ('owner','admin','agent','technician') THEN
          RAISE EXCEPTION 'dispatch access denied' USING ERRCODE='42501'; END IF;
        IF p_view NOT IN ('available','mine') THEN RAISE EXCEPTION 'invalid queue view' USING ERRCODE='22023'; END IF;
        SELECT id INTO v_technician FROM service.technicians WHERE tenant_id=platform.current_tenant_id()
          AND active AND linked_user_id=platform.current_user_id();
        IF v_role='technician' AND v_technician IS NULL THEN
          RAISE EXCEPTION 'an individual technician account is required' USING ERRCODE='42501'; END IF;
        IF p_view='available' AND NOT coalesce((service.current_workflow_policy()->>'selfAssignmentEnabled')::boolean,false)
          AND v_role='technician' THEN RETURN; END IF;
        RETURN QUERY SELECT jsonb_build_object('id',c.id,'reference',c.reference,'title',c.title,
          'faultDescription',left(c.fault_description,1000),'status',c.status,'priority',c.priority,
          'customerName',contact.name,'storeName',location.name,'chainName',chain.name,
          'assignedTechnicianId',c.assigned_technician_id,'assignedTechnicianName',tech.full_name,'updatedAt',c.updated_at)
        FROM service.cases c JOIN crm.contacts contact ON contact.tenant_id=c.tenant_id AND contact.id=c.customer_contact_id
        LEFT JOIN crm.service_locations location ON location.tenant_id=c.tenant_id AND location.id=c.service_location_id
        LEFT JOIN crm.service_chains chain ON chain.tenant_id=location.tenant_id AND chain.id=location.chain_id
        LEFT JOIN service.technicians tech ON tech.tenant_id=c.tenant_id AND tech.id=c.assigned_technician_id
        WHERE c.tenant_id=platform.current_tenant_id() AND c.status NOT IN ('closed','cancelled','completed')
          AND CASE WHEN p_view='available' THEN c.assigned_technician_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM service.visits v WHERE v.tenant_id=c.tenant_id AND v.case_id=c.id AND v.status<>'cancelled')
            AND NOT EXISTS(SELECT 1 FROM service.appointments a WHERE a.tenant_id=c.tenant_id AND a.case_id=c.id AND a.status<>'cancelled')
          ELSE c.assigned_technician_id=v_technician OR EXISTS(SELECT 1 FROM service.visits v WHERE v.tenant_id=c.tenant_id AND v.case_id=c.id AND v.technician_id=v_technician AND v.status<>'cancelled') END
        ORDER BY CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,c.created_at,c.id LIMIT 100;
      END $$;
      CREATE FUNCTION service.assign_case(p_case uuid,p_technician uuid,p_reason text)
      RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_tech uuid; v_prior uuid; v_visit uuid; v_case service.cases%ROWTYPE;
        v_role text:=coalesce(current_setting('app.current_role',true),'');
      BEGIN
        IF NOT service.field_service_enabled() OR NOT platform.current_tenant_feature_enabled('technicians') OR NOT platform.current_tenant_active() THEN
          RAISE EXCEPTION 'dispatch disabled' USING ERRCODE='42501'; END IF;
        PERFORM 1 FROM service.lock_current_technician_session_context();
        IF NOT FOUND THEN RAISE EXCEPTION 'active authenticated session required' USING ERRCODE='42501'; END IF;
        IF p_technician IS NULL THEN
          IF NOT coalesce((service.current_workflow_policy()->>'selfAssignmentEnabled')::boolean,false) THEN
            RAISE EXCEPTION 'self assignment disabled' USING ERRCODE='42501'; END IF;
          SELECT id INTO v_tech FROM service.technicians WHERE tenant_id=v_tenant AND linked_user_id=platform.current_user_id() AND active FOR SHARE;
        ELSE
          IF v_role NOT IN ('owner','admin') OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 1000 THEN
            RAISE EXCEPTION 'manager and reassignment reason required' USING ERRCODE='42501'; END IF;
          SELECT id INTO v_tech FROM service.technicians WHERE tenant_id=v_tenant AND id=p_technician AND active FOR SHARE;
        END IF;
        IF v_tech IS NULL THEN RAISE EXCEPTION 'eligible technician not found' USING ERRCODE='42501'; END IF;
        SELECT * INTO v_case FROM service.cases WHERE tenant_id=v_tenant AND id=p_case FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'case not found' USING ERRCODE='P0002'; END IF;
        IF v_case.status IN ('closed','completed','cancelled') THEN RAISE EXCEPTION 'case is not assignable' USING ERRCODE='23514'; END IF;
        v_prior:=v_case.assigned_technician_id;
        IF v_prior IS NOT NULL AND v_prior<>v_tech AND p_technician IS NULL THEN
          RAISE EXCEPTION 'another technician already claimed this incident' USING ERRCODE='40001'; END IF;
        IF p_technician IS NULL AND EXISTS(SELECT 1 FROM service.appointments WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id<>v_tech AND status<>'cancelled') THEN
          RAISE EXCEPTION 'incident is already scheduled' USING ERRCODE='40001'; END IF;
        IF EXISTS(SELECT 1 FROM service.visits WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id<>v_tech AND status IN ('arrived','departed','reported')) THEN
          RAISE EXCEPTION 'an attended visit cannot be reassigned' USING ERRCODE='23514'; END IF;
        IF p_technician IS NULL AND EXISTS(SELECT 1 FROM service.visits WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id<>v_tech AND status<>'cancelled') THEN
          RAISE EXCEPTION 'incident already assigned' USING ERRCODE='40001'; END IF;
        UPDATE service.visits SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id<>v_tech AND status='assigned';
        UPDATE service.appointments SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id<>v_tech AND status IN ('suggested','scheduled');
        UPDATE service.cases SET assigned_technician_id=v_tech,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND id=p_case;
        SELECT id INTO v_visit FROM service.visits WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id=v_tech AND status<>'cancelled' ORDER BY visit_number DESC LIMIT 1;
        IF v_visit IS NULL THEN
          INSERT INTO service.visits(tenant_id,case_id,technician_id,visit_number)
          SELECT v_tenant,p_case,v_tech,coalesce(max(visit_number),0)+1 FROM service.visits WHERE tenant_id=v_tenant AND case_id=p_case RETURNING id INTO v_visit;
        END IF;
        IF v_prior IS DISTINCT FROM v_tech THEN
          INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
          VALUES(v_tenant,platform.current_user_id(),CASE WHEN p_technician IS NULL THEN 'field_service.case.claimed' ELSE 'field_service.case.reassigned' END,
            'service_case',p_case,jsonb_build_object('previousTechnicianId',v_prior,'technicianId',v_tech,'reason',p_reason,'visitId',v_visit));
        END IF;
        RETURN jsonb_build_object('caseId',p_case,'technicianId',v_tech,'visitId',v_visit);
      END $$;
    """)
    _voice_intake()
    _photo_linking()
    for signature in (
        "service.current_workflow_policy()",
        "service.intake_missing_fields(jsonb,jsonb)",
        "service.intake_has_photo(uuid)",
        "service.list_assignment_queue(text)",
        "service.assign_case(uuid,uuid,text)",
        "service.voice_intake_context(uuid)",
        "service.voice_caller_identity(uuid,text)",
        "service.capture_service_intake(uuid,jsonb,boolean)",
        "service.request_voice_intake_photos(uuid,text)",
        "service.pin_intake_workflow()",
        "service.validate_workflow_policy(jsonb)",
        "service.contact_intake_context(uuid)",
        "service.link_case_support_ticket()",
        "service.attach_followup_evidence()",
    ):
        _execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
    _execute(
        "GRANT EXECUTE ON FUNCTION service.current_workflow_policy(),service.intake_missing_fields(jsonb,jsonb),service.intake_has_photo(uuid) TO platform_web,platform_worker,platform_messaging,platform_voice"
    )
    _execute("GRANT EXECUTE ON FUNCTION service.validate_workflow_policy(jsonb) TO platform_web")
    _execute(
        "GRANT EXECUTE ON FUNCTION service.contact_intake_context(uuid) TO platform_web,platform_worker,platform_messaging"
    )
    _execute(
        "GRANT EXECUTE ON FUNCTION service.list_assignment_queue(text),service.assign_case(uuid,uuid,text) TO platform_web"
    )
    _execute(
        "GRANT EXECUTE ON FUNCTION service.voice_intake_context(uuid),service.voice_caller_identity(uuid,text),service.capture_service_intake(uuid,jsonb,boolean),service.request_voice_intake_photos(uuid,text) TO platform_voice"
    )


def _voice_intake() -> None:
    _execute("""
      CREATE FUNCTION service.voice_caller_identity(p_session uuid,p_phone text) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT identity.id FROM public.sessions session JOIN crm.contact_channel_identities identity
          ON identity.tenant_id=session.tenant_id AND identity.contact_id=session.contact_id
        WHERE session.tenant_id=platform.current_tenant_id() AND session.session_id=p_session
          AND identity.normalized_value=p_phone AND identity.channel IN ('phone','whatsapp')
          AND identity.validation_status NOT IN ('invalid','revoked')
          AND platform.current_tenant_active() AND platform.current_tenant_feature_enabled('voice')
        ORDER BY identity.is_primary DESC,identity.created_at,identity.id LIMIT 1
      $$;
      CREATE FUNCTION service.voice_intake_context(p_session uuid) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_contact uuid; v_fields jsonb; v_draft service.intake_drafts%ROWTYPE;
        v_policy jsonb; v_case service.cases%ROWTYPE; v_ticket uuid; v_agent uuid; v_sequence integer; v_contact_context jsonb; v_identity uuid; v_phone text;
      BEGIN
        IF NOT service.field_service_enabled() OR NOT platform.current_tenant_feature_enabled('voice') OR NOT platform.current_tenant_feature_enabled('tickets') OR NOT platform.current_tenant_active() THEN
          RAISE EXCEPTION 'service intake unavailable' USING ERRCODE='42501'; END IF;
        SELECT contact_id INTO v_contact FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session;
        IF v_contact IS NULL THEN RAISE EXCEPTION 'verified caller required' USING ERRCODE='42501'; END IF;
        SELECT (payload->>'agent_version_id')::uuid,(payload->>'caller_identity_id')::uuid INTO v_agent,v_identity FROM public.session_events WHERE tenant_id=v_tenant AND session_id=p_session AND event_type='voice.agent.binding.v1' ORDER BY created_at LIMIT 1;
        IF NOT EXISTS(SELECT 1 FROM agents.agent_profile_versions WHERE tenant_id=v_tenant AND id=v_agent AND published_at IS NOT NULL AND validation_status='valid' AND tool_permissions ? 'service.intake') THEN
          RAISE EXCEPTION 'published service intake capability required' USING ERRCODE='42501'; END IF;
        PERFORM 1 FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session FOR UPDATE;
        SELECT payload INTO v_policy FROM public.session_events WHERE tenant_id=v_tenant AND session_id=p_session AND event_type='voice.service.policy.v1' ORDER BY sequence LIMIT 1;
        IF v_policy IS NULL THEN
          v_policy:=service.current_workflow_policy();
          SELECT coalesce(max(sequence),-1)+1 INTO v_sequence FROM public.session_events WHERE tenant_id=v_tenant AND session_id=p_session;
          INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,version,payload,occurred_at) VALUES(v_tenant,p_session,v_sequence,'voice.service.policy.v1',1,v_policy,CURRENT_TIMESTAMP);
        END IF;
        IF EXISTS(SELECT 1 FROM automation.voice_identity_verifications WHERE tenant_id=v_tenant AND session_id=p_session AND state<>'context_unlocked') THEN
          RETURN jsonb_build_object('policy',v_policy,'knownFields','{}'::jsonb,'intakeId',NULL,'status','identity_required','missingFields','[]'::jsonb);
        END IF;
        v_contact_context:=service.contact_intake_context(v_contact);
        v_fields:=v_contact_context->'knownFields';
        IF v_identity IS NOT NULL THEN
          SELECT normalized_value INTO v_phone FROM crm.contact_channel_identities WHERE tenant_id=v_tenant AND contact_id=v_contact AND id=v_identity AND validation_status NOT IN ('invalid','revoked');
          v_fields:=(v_fields-'customerPhone')||jsonb_strip_nulls(jsonb_build_object('customerPhone',v_phone));
        END IF;
        SELECT * INTO v_draft FROM service.intake_drafts WHERE tenant_id=v_tenant AND source_session_id=p_session;
        v_policy:=coalesce(v_draft.workflow_policy,v_policy);
        v_fields:=v_fields||coalesce(v_draft.collected_fields,'{}'::jsonb);
        SELECT * INTO v_case FROM service.cases WHERE tenant_id=v_tenant AND intake_draft_id=v_draft.id;
        SELECT id INTO v_ticket FROM support.tickets WHERE tenant_id=v_tenant AND service_case_id=v_case.id LIMIT 1;
        RETURN jsonb_build_object('policy',v_policy,'knownFields',v_fields,'storeOptions',v_contact_context->'storeOptions','intakeId',v_draft.id,'caseId',v_case.id,'ticketId',v_ticket,'reference',v_case.reference,
          'status',coalesce(v_draft.status,'not_started'),'missingFields',service.intake_missing_fields(v_fields,v_policy));
      END $$;
      CREATE FUNCTION service.capture_service_intake(p_session uuid,p_fields jsonb,p_confirmed boolean) RETURNS jsonb
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
    """)


def _photo_linking() -> None:
    _execute("""
      CREATE FUNCTION service.request_voice_intake_photos(p_session uuid,p_message text) RETURNS jsonb
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
      END $$;
      CREATE FUNCTION service.attach_followup_evidence() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_case uuid; v_intake uuid; v_candidates integer;
      BEGIN
        IF NEW.direction<>'inbound' OR NEW.content_type NOT IN ('image','document') OR NEW.object_id IS NULL THEN RETURN NEW; END IF;
        SELECT count(*),(array_agg(d.id))[1] INTO v_candidates,v_intake FROM service.intake_drafts d WHERE d.tenant_id=NEW.tenant_id AND d.conversation_id=NEW.conversation_id
          AND d.status IN ('collecting','awaiting_confirmation','confirmed') AND d.updated_at>CURRENT_TIMESTAMP-interval '7 days';
        IF v_candidates<>1 THEN RETURN NEW; END IF;
        INSERT INTO service.intake_messages(tenant_id,intake_draft_id,message_id) VALUES(NEW.tenant_id,v_intake,NEW.id) ON CONFLICT DO NOTHING;
        SELECT id INTO v_case FROM service.cases WHERE tenant_id=NEW.tenant_id AND intake_draft_id=v_intake AND status NOT IN ('closed','cancelled');
        IF v_case IS NOT NULL AND EXISTS(SELECT 1 FROM objects.object_metadata WHERE tenant_id=NEW.tenant_id AND id=NEW.object_id AND status='available' AND deleted_at IS NULL) THEN
          INSERT INTO service.report_attachments(tenant_id,case_id,message_id,object_id,category,source,processing_status)
          VALUES(NEW.tenant_id,v_case,NEW.id,NEW.object_id,CASE WHEN NEW.content_type='image' THEN 'customer_photo' ELSE 'document' END,'customer','available') ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER service_followup_evidence AFTER INSERT OR UPDATE OF object_id,status ON messaging.messages FOR EACH ROW EXECUTE FUNCTION service.attach_followup_evidence();
    """)


def downgrade() -> None:
    _execute("DROP TRIGGER service_followup_evidence ON messaging.messages")
    _execute("DROP TRIGGER service_case_support_ticket ON service.cases")
    _execute("DROP TRIGGER service_case_policy ON service.cases")
    _execute("DROP TRIGGER service_intake_policy ON service.intake_drafts")
    for signature in (
        "service.attach_followup_evidence()",
        "service.request_voice_intake_photos(uuid,text)",
        "service.capture_service_intake(uuid,jsonb,boolean)",
        "service.voice_intake_context(uuid)",
        "service.voice_caller_identity(uuid,text)",
        "service.assign_case(uuid,uuid,text)",
        "service.list_assignment_queue(text)",
        "service.link_case_support_ticket()",
        "service.pin_intake_workflow()",
        "service.intake_missing_fields(jsonb,jsonb)",
        "service.intake_has_photo(uuid)",
        "service.current_workflow_policy()",
        "service.validate_workflow_policy(jsonb)",
        "service.contact_intake_context(uuid)",
    ):
        _execute(f"DROP FUNCTION IF EXISTS {signature}")
    _execute(
        "ALTER TABLE service.cases DROP COLUMN assigned_technician_id, DROP COLUMN workflow_policy"
    )
    _execute(
        "ALTER TABLE service.intake_drafts DROP COLUMN source_session_id, DROP COLUMN workflow_policy"
    )
    _execute("ALTER TABLE crm.service_locations DROP COLUMN chain_id")
    _execute("DROP TABLE crm.service_chains")
