"""Require fresh session proof before disclosing private caller CRM prefill."""

from alembic import op
from sqlalchemy import DDL as SchemaDDL

revision = "ed735fc042b7"
down_revision = "ec624ebf31a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        SchemaDDL(
            r"""
CREATE OR REPLACE FUNCTION service.voice_intake_context(p_session uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_tenant uuid:=platform.current_tenant_id(); v_contact uuid; v_fields jsonb;
v_draft service.intake_drafts%ROWTYPE;
v_policy jsonb; v_case service.cases%ROWTYPE; v_ticket uuid; v_agent uuid; v_sequence
integer; v_contact_context jsonb; v_identity uuid; v_phone text; v_context_authorized
boolean;
BEGIN
IF NOT service.field_service_enabled() OR NOT
platform.current_tenant_feature_enabled('voice') OR NOT
platform.current_tenant_feature_enabled('tickets') OR NOT
platform.current_tenant_active() THEN
RAISE EXCEPTION 'service intake unavailable' USING ERRCODE='42501'; END IF;
SELECT contact_id INTO v_contact FROM public.sessions WHERE tenant_id=v_tenant AND
session_id=p_session;
IF v_contact IS NULL THEN RAISE EXCEPTION 'verified caller required' USING
ERRCODE='42501'; END IF;
SELECT (payload->>'agent_version_id')::uuid,(payload->>'caller_identity_id')::uuid INTO
v_agent,v_identity FROM public.session_events WHERE tenant_id=v_tenant AND
session_id=p_session AND event_type='voice.agent.binding.v1' ORDER BY created_at LIMIT
1;
IF NOT EXISTS(
 SELECT 1 FROM agents.agent_profile_versions agent
 JOIN agents.agent_profiles profile ON profile.tenant_id=agent.tenant_id
 AND profile.id=agent.agent_profile_id
 WHERE agent.tenant_id=v_tenant AND agent.id=v_agent AND profile.archived_at IS NULL
 AND agent.published_at IS NOT NULL AND agent.validation_status='valid'
 AND agent.tool_permissions ? 'service.intake'
) THEN
RAISE EXCEPTION 'published service intake capability required' USING ERRCODE='42501';
END IF;
PERFORM 1 FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session FOR
UPDATE;
SELECT payload INTO v_policy FROM public.session_events WHERE tenant_id=v_tenant AND
session_id=p_session AND event_type='voice.service.policy.v1' ORDER BY sequence LIMIT 1;
IF v_policy IS NULL THEN
v_policy:=service.current_workflow_policy();
SELECT coalesce(max(sequence),-1)+1 INTO v_sequence FROM public.session_events WHERE
tenant_id=v_tenant AND session_id=p_session;
INSERT INTO
public.session_events(tenant_id,session_id,sequence,event_type,version,payload,occurred_at)
VALUES(v_tenant,p_session,v_sequence,'voice.service.policy.v1',1,v_policy,CURRENT_TIMESTAMP);
END IF;
IF EXISTS(SELECT 1 FROM automation.voice_identity_verifications WHERE tenant_id=v_tenant
AND session_id=p_session AND state<>'context_unlocked') THEN
RETURN
jsonb_build_object('policy',v_policy,'knownFields','{}'::jsonb,'intakeId',NULL,'status','identity_required','missingFields','[]'::jsonb);
END IF;
v_context_authorized:=EXISTS(
SELECT 1 FROM automation.voice_identity_verifications verification
WHERE verification.tenant_id=v_tenant AND verification.session_id=p_session
AND verification.contact_id=v_contact AND verification.state='context_unlocked'
AND verification.verified_at IS NOT NULL
AND verification.context_unlocked_at IS NOT NULL
) AND service.voice_session_caller_identity(v_tenant,p_session) IS NOT NULL;
IF v_context_authorized THEN
v_contact_context:=service.contact_intake_context(v_contact);
ELSE
v_contact_context:=jsonb_build_object('knownFields','{}'::jsonb,'storeOptions','[]'::jsonb);
END IF;
v_fields:=v_contact_context->'knownFields';
IF v_context_authorized AND v_identity IS NOT NULL THEN
SELECT normalized_value INTO v_phone FROM crm.contact_channel_identities WHERE
tenant_id=v_tenant AND contact_id=v_contact AND id=v_identity AND validation_status NOT
IN ('invalid','revoked');
v_fields:=(v_fields-'customerPhone')||jsonb_strip_nulls(jsonb_build_object('customerPhone',v_phone));
END IF;
SELECT * INTO v_draft FROM service.intake_drafts WHERE tenant_id=v_tenant AND
source_session_id=p_session;
v_policy:=coalesce(v_draft.workflow_policy,v_policy);
IF NOT v_context_authorized AND v_draft.id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM public.session_events e
 WHERE e.tenant_id=v_tenant AND e.session_id=p_session
 AND e.event_type='voice.intake.claims.v2'
 AND e.payload->>'intake_id'=v_draft.id::text
 AND e.payload->>'source'='caller_reported_only'
) THEN
 -- A legacy or formerly verified draft may contain private CRM prefill.
 -- Preserve it for authorized staff; do not infer provenance from its text.
 RETURN jsonb_build_object('policy',v_policy,'knownFields','{}'::jsonb,
  'storeOptions','[]'::jsonb,'intakeId',NULL,'caseId',NULL,'ticketId',NULL,
  'status','identity_required','missingFields','[]'::jsonb);
END IF;
v_fields:=v_fields||coalesce(v_draft.collected_fields,'{}'::jsonb);
SELECT * INTO v_case FROM service.cases WHERE tenant_id=v_tenant AND
intake_draft_id=v_draft.id;
SELECT id INTO v_ticket FROM support.tickets WHERE tenant_id=v_tenant AND
service_case_id=v_case.id LIMIT 1;
RETURN
jsonb_build_object('policy',v_policy,'knownFields',v_fields,'storeOptions',v_contact_context->'storeOptions','intakeId',v_draft.id,'caseId',v_case.id,'ticketId',v_ticket,'reference',v_case.reference,
'status'
,coalesce(v_draft.status,'not_started'),'missingFields',service.intake_missing_fields(v_fields,v_policy));
END $$;
    """.replace("%", "%%")
        )
    )

    op.execute(
        SchemaDDL(
            r"""
CREATE OR REPLACE FUNCTION service.capture_service_intake(p_session uuid,p_fields
jsonb,p_confirmed boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_context jsonb; v_tenant uuid:=platform.current_tenant_id(); v_contact uuid;
v_fields jsonb; v_policy jsonb;
v_intake uuid; v_case uuid; v_location uuid; v_chain uuid; v_key text; v_value jsonb;
v_missing jsonb; v_reference text; v_conversation uuid;
v_ticket support.tickets%ROWTYPE; v_changed text[]:=ARRAY[]::text[]; v_urgency text;
v_transport_phone text; v_sequence integer;
BEGIN
PERFORM
pg_advisory_xact_lock(hashtextextended(v_tenant::text||':voice-service:'||p_session::text,0));
v_context:=service.voice_intake_context(p_session);
IF v_context->>'status'='identity_required' THEN RAISE EXCEPTION
'verify caller identity first' USING ERRCODE='42501'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.sessions WHERE tenant_id=v_tenant AND
session_id=p_session AND ended_at IS NULL)
OR EXISTS(SELECT 1 FROM public.voice_session_controls WHERE tenant_id=v_tenant AND
session_id=p_session AND desired_mode<>'ai') THEN
RAISE EXCEPTION 'voice conversation no longer permits agent actions' USING
ERRCODE='42501'; END IF;
IF v_context->>'caseId' IS NOT NULL THEN RETURN v_context; END IF;
IF jsonb_typeof(p_fields) IS DISTINCT FROM 'object' OR
octet_length(p_fields::text)>16384 THEN RAISE EXCEPTION 'invalid intake fields' USING
ERRCODE='22023'; END IF;
v_fields:=v_context->'knownFields'; v_policy:=v_context->'policy';
-- A callback destination is transport correlation, never identity proof.
IF NOT (v_fields ? 'customerPhone' ) THEN
SELECT identity.normalized_value INTO v_transport_phone
FROM crm.contact_channel_identities identity
WHERE identity.tenant_id=v_tenant
AND identity.id=service.voice_session_caller_identity(v_tenant,p_session);
IF v_transport_phone IS NOT NULL THEN
v_fields:=v_fields||jsonb_build_object('customerPhone',v_transport_phone);
IF NOT EXISTS(SELECT 1 FROM public.session_events
WHERE tenant_id=v_tenant AND session_id=p_session
AND event_type='voice.caller.correlation.v1') THEN
SELECT coalesce(max(sequence),-1)+1 INTO v_sequence
FROM public.session_events WHERE tenant_id=v_tenant AND session_id=p_session;
INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload)
VALUES(v_tenant,p_session,v_sequence,'voice.caller.correlation.v1',
jsonb_build_object('source','provider_transport','identity_verified',false,
'purpose' ,'callback_routing'));
END IF;
END IF;
END IF;
FOR v_key,v_value IN SELECT key,value FROM jsonb_each(p_fields) LOOP
IF v_key NOT IN
('customerName','chainName','storeName','storeId','serviceAddress','faultDescription','exactFailure','productType','productModel','serialNumber','warrantyStatus','callbackNumber','urgency')
OR jsonb_typeof(v_value)<>'string' THEN
RAISE EXCEPTION 'unsupported intake field' USING ERRCODE='22023'; END IF;
IF length(btrim(v_value#>>'{}'))>(CASE WHEN v_key='faultDescription' THEN 10000 WHEN
v_key='exactFailure' THEN 2000 WHEN v_key='serviceAddress' THEN 500 ELSE 160 END) THEN
RAISE EXCEPTION 'intake field too long' USING ERRCODE='22023'; END IF;
IF v_key='urgency' AND btrim(v_value#>>'{}') NOT IN ('low','normal','high','urgent')
THEN RAISE EXCEPTION 'unsupported urgency' USING ERRCODE='22023'; END IF;
IF v_key='callbackNumber' AND nullif(btrim(v_value#>>'{}'),'') IS NOT NULL AND
btrim(v_value#>>'{}') !~ '^\+?[0-9][0-9 ()-]{6,22}$' THEN RAISE EXCEPTION
'invalid callback number' USING ERRCODE='22023'; END IF;
IF nullif(btrim(v_value#>>'{}'),'') IS NOT NULL THEN
IF v_fields->>v_key IS DISTINCT FROM btrim(v_value#>>'{}') THEN
v_changed:=array_append(v_changed,v_key); END IF;
v_fields:=v_fields||jsonb_build_object(v_key,btrim(v_value#>>'{}'));
END IF;
END LOOP;
IF v_fields->>'storeId' IS NOT NULL THEN
SELECT location.id,location.chain_id INTO v_location,v_chain FROM crm.service_locations
location WHERE location.tenant_id=v_tenant AND location.id=(v_fields->>'storeId')::uuid
AND location.archived_at IS NULL;
IF v_location IS NULL THEN RAISE EXCEPTION 'store is not in tenant directory' USING
ERRCODE='22023'; END IF;
SELECT
v_fields||jsonb_strip_nulls(jsonb_build_object('storeName',location.name,'serviceAddress',location.address,'chainName',chain.name))
INTO v_fields
FROM crm.service_locations location LEFT JOIN crm.service_chains chain ON
chain.tenant_id=location.tenant_id AND chain.id=location.chain_id WHERE
location.tenant_id=v_tenant AND location.id=v_location;
END IF;
SELECT contact_id INTO v_contact FROM public.sessions WHERE tenant_id=v_tenant AND
session_id=p_session;
v_missing:=service.intake_missing_fields(v_fields,v_policy);
IF p_fields->>'customerName' IS NOT NULL THEN
UPDATE crm.contacts SET name=v_fields->>'customerName',updated_at=CURRENT_TIMESTAMP
WHERE tenant_id=v_tenant AND id=v_contact AND name ~ '^\+?[0-9 ()-]{7,}$' ;
END IF;
INSERT INTO
service.intake_drafts(tenant_id,source_session_id,reporting_contact_id,customer_contact_id,customer_resolution_status,correlation_key,collected_fields,status)
VALUES(v_tenant,p_session,v_contact,v_contact,'reporting_contact','voice:'||p_session::text,v_fields,CASE
WHEN jsonb_array_length(v_missing)=0 THEN 'awaiting_confirmation' ELSE 'collecting' END)
ON CONFLICT(tenant_id,source_session_id) WHERE source_session_id IS NOT NULL DO UPDATE
SET
collected_fields=EXCLUDED.collected_fields,status=EXCLUDED.status,updated_at=CURRENT_TIMESTAMP
RETURNING id INTO v_intake;
IF NOT EXISTS(SELECT 1 FROM automation.voice_identity_verifications proof
 WHERE proof.tenant_id=v_tenant AND proof.session_id=p_session
 AND proof.state='context_unlocked') THEN
 IF NOT EXISTS(SELECT 1 FROM public.session_events e
  WHERE e.tenant_id=v_tenant AND e.session_id=p_session
  AND e.event_type='voice.intake.claims.v2') THEN
  SELECT coalesce(max(sequence),-1)+1 INTO v_sequence FROM public.session_events
  WHERE tenant_id=v_tenant AND session_id=p_session;
  INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload)
  VALUES(v_tenant,p_session,v_sequence,'voice.intake.claims.v2',
   jsonb_build_object('source','caller_reported_only','intake_id',v_intake,
    'identity_verified',false));
 END IF;
END IF;
UPDATE service.intake_drafts SET workflow_policy=v_policy WHERE tenant_id=v_tenant AND
id=v_intake;
-- Incremental visibility: the inquiry reflects each saved fact as it is
-- captured, so a dropped call leaves what the caller already said.
SELECT * INTO v_ticket FROM support.tickets WHERE tenant_id=v_tenant AND
attachment_key='voice-session:'||p_session::text FOR UPDATE;
IF FOUND AND v_ticket.status='open' THEN
v_urgency:=v_fields->>'urgency';
UPDATE support.tickets SET intake_draft_id=coalesce(intake_draft_id,v_intake),
subject=CASE WHEN 'faultDescription' =ANY(v_changed) THEN
left(regexp_replace(v_fields->>'faultDescription','\s+',' ','g'),200) ELSE subject END,
priority=CASE WHEN emergency_at IS NOT NULL THEN 'urgent' WHEN v_urgency IN
('low','normal','high','urgent') THEN v_urgency ELSE priority END,
updated_at=clock_timestamp()
WHERE tenant_id=v_tenant AND id=v_ticket.id;
IF cardinality(v_changed)>0 THEN
PERFORM support.append_ticket_event(v_tenant,v_ticket.id,'customer_update','customer',
'Service details captured: ' ||array_to_string(v_changed,', '),jsonb_build_object('
fields',to_jsonb(v_changed),'intakeId',v_intake));
END IF;
END IF;
IF NOT coalesce(p_confirmed,false) OR jsonb_array_length(v_missing)>0 THEN RETURN
service.voice_intake_context(p_session); END IF;
IF v_policy->>'photoPolicy'='required' AND NOT EXISTS(SELECT 1 FROM
service.intake_messages im JOIN messaging.messages m ON m.tenant_id=im.tenant_id AND
m.id=im.message_id JOIN objects.object_metadata o ON o.tenant_id=m.tenant_id AND
o.id=m.object_id WHERE im.tenant_id=v_tenant AND im.intake_draft_id=v_intake AND
m.content_type='image' AND o.status='available' AND o.deleted_at IS NULL) THEN
RETURN
service.voice_intake_context(p_session)||jsonb_build_object('missingFields',v_missing||'["photos"]'::jsonb);
END IF;
IF v_location IS NULL AND v_fields->>'storeName' IS NOT NULL THEN
IF v_fields->>'chainName' IS NOT NULL THEN
SELECT id INTO v_chain FROM crm.service_chains WHERE tenant_id=v_tenant AND
lower(name)=lower(v_fields->>'chainName') AND active;
IF v_chain IS NULL THEN INSERT INTO crm.service_chains(tenant_id,name)
VALUES(v_tenant,v_fields->>'chainName') ON CONFLICT(tenant_id,lower(name)) DO UPDATE SET
name=EXCLUDED.name RETURNING id INTO v_chain; END IF;
END IF;
SELECT id INTO v_location FROM crm.service_locations WHERE tenant_id=v_tenant AND
chain_id IS NOT DISTINCT FROM v_chain AND lower(name)=lower(v_fields->>'storeName') AND
archived_at IS NULL ORDER BY id LIMIT 1;
IF v_location IS NULL THEN INSERT INTO
crm.service_locations(tenant_id,customer_contact_id,chain_id,name,address)
VALUES(v_tenant,v_contact,v_chain,v_fields->>'storeName',v_fields->>'serviceAddress')
RETURNING id INTO v_location; END IF;
END IF;
v_case:=gen_random_uuid();
v_reference:='FS-'||to_char(CURRENT_TIMESTAMP,'YYYY')||'-'||upper(left(replace(v_case::text,'-',''),8));
SELECT conversation_id INTO v_conversation FROM service.intake_drafts WHERE
tenant_id=v_tenant AND id=v_intake;
INSERT INTO
service.cases(id,tenant_id,reference,customer_contact_id,reporting_contact_id,service_location_id,intake_draft_id,conversation_id,title,fault_description,product_type,product_model,serial_number,source,priority)
VALUES(v_case,v_tenant,v_reference,v_contact,v_contact,v_location,v_intake,v_conversation,left(v_fields->>'faultDescription',200),left((v_fields->>'faultDescription')||CASE
WHEN v_fields->>'exactFailure' IS NULL THEN '' ELSE E'\n'||(v_fields->>'exactFailure')
END,10000),v_fields->>'productType',v_fields->>'productModel',v_fields->>'serialNumber','voice',
CASE WHEN v_ticket.emergency_at IS NOT NULL THEN 'urgent' WHEN v_fields->>'urgency' IN
('low','normal','high','urgent') THEN v_fields->>'urgency' ELSE 'normal' END);
UPDATE service.cases SET workflow_policy=service.redact_workflow_policy(v_policy) WHERE
tenant_id=v_tenant AND id=v_case;
INSERT INTO service.case_calls(tenant_id,case_id,session_id,relationship)
VALUES(v_tenant,v_case,p_session,'intake');
IF v_conversation IS NOT NULL THEN INSERT INTO
service.case_conversations(tenant_id,case_id,conversation_id,relationship)
VALUES(v_tenant,v_case,v_conversation,'intake') ON CONFLICT DO NOTHING; END IF;
INSERT INTO
service.report_attachments(tenant_id,case_id,message_id,object_id,category,source,processing_status)
SELECT v_tenant,v_case,m.id,m.object_id,CASE WHEN m.content_type='image' THEN
'customer_photo' ELSE 'document' END,'customer','available'
FROM service.intake_messages im JOIN messaging.messages m ON m.tenant_id=im.tenant_id
AND m.id=im.message_id
JOIN objects.object_metadata o ON o.tenant_id=m.tenant_id AND o.id=m.object_id
WHERE im.tenant_id=v_tenant AND im.intake_draft_id=v_intake AND m.direction='inbound'
AND m.content_type IN ('image','document') AND o.status='available' AND o.deleted_at IS
NULL ON CONFLICT DO NOTHING;
INSERT INTO service.case_status_history(tenant_id,case_id,to_status,actor_service)
VALUES(v_tenant,v_case,'awaiting_scheduling','voice-intake');
UPDATE service.intake_drafts SET
status='confirmed',confirmed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE
tenant_id=v_tenant AND id=v_intake;
INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
VALUES(v_tenant,'voice-intake','field_service.intake.confirmed','service_case',v_case,jsonb_build_object('sessionId',p_session,'intakeId',v_intake));
RETURN service.voice_intake_context(p_session);
END $$;
    """.replace("%", "%%")
        )
    )

    op.execute(
        SchemaDDL(
            r"""
CREATE OR REPLACE FUNCTION service.open_voice_inquiry(p_session uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_tenant uuid:=platform.current_tenant_id(); v_context jsonb; v_policy jsonb; v_contact
uuid; v_intake uuid;
v_receipt jsonb; v_hebrew boolean; v_created uuid; v_sequence integer;
BEGIN
PERFORM
pg_advisory_xact_lock(hashtextextended(v_tenant::text||':voice-service:'||p_session::text,0));
v_context:=service.voice_intake_context(p_session);
v_policy:=v_context->'policy';
IF coalesce((v_policy#>>'{inquiry,openOnFirstContact}')::boolean,false) IS NOT TRUE THEN
RETURN jsonb_build_object('status','not_configured'); END IF;
IF v_context->>'status'='identity_required' THEN RETURN
jsonb_build_object('status','identity_required'); END IF;
PERFORM
pg_advisory_xact_lock(hashtextextended(v_tenant::text||':voice-service:'||p_session::text,0));
SELECT contact_id INTO v_contact FROM public.sessions WHERE tenant_id=v_tenant AND
session_id=p_session;
INSERT INTO
service.intake_drafts(tenant_id,source_session_id,reporting_contact_id,customer_contact_id,customer_resolution_status,correlation_key,collected_fields,status)
VALUES(v_tenant,p_session,v_contact,v_contact,'reporting_contact','voice:'||p_session::text,coalesce(v_context->'knownFields','{}'::jsonb),'collecting')
ON CONFLICT(tenant_id,source_session_id) WHERE source_session_id IS NOT NULL
DO NOTHING RETURNING id INTO v_created;
SELECT id INTO v_intake FROM service.intake_drafts WHERE tenant_id=v_tenant AND
source_session_id=p_session;
-- Only this fresh insert is known to contain no private CRM prefill.
-- Existing or formerly verified drafts must retain their provenance.
IF v_created IS NOT NULL AND NOT EXISTS(
SELECT 1 FROM automation.voice_identity_verifications proof
WHERE proof.tenant_id=v_tenant AND proof.session_id=p_session
AND proof.state='context_unlocked') THEN
SELECT coalesce(max(sequence),-1)+1 INTO v_sequence FROM public.session_events
WHERE tenant_id=v_tenant AND session_id=p_session;
INSERT INTO public.session_events(tenant_id,session_id,sequence,event_type,payload)
VALUES(v_tenant,p_session,v_sequence,'voice.intake.claims.v2',
jsonb_build_object('source','caller_reported_only','intake_id',v_created,
'identity_verified',false));
END IF;
UPDATE service.intake_drafts SET workflow_policy=v_policy WHERE tenant_id=v_tenant AND
id=v_intake AND workflow_policy IS DISTINCT FROM v_policy
AND NOT EXISTS(SELECT 1 FROM service.cases WHERE tenant_id=v_tenant AND intake_draft_id=v_intake);
v_hebrew:=service.tenant_is_hebrew(v_tenant);
v_receipt:=support.open_ticket_from_voice_session(p_session,
CASE WHEN v_hebrew THEN 'פנייה טלפונית' ELSE 'Phone inquiry' END,
CASE WHEN v_hebrew THEN 'שיחה נכנסת התחילה. פרטי השירות נאספים.' ELSE 'Inbound call started.
Service details are being collected.' END);
UPDATE support.tickets SET intake_draft_id=v_intake WHERE tenant_id=v_tenant AND
attachment_key='voice-session:'||p_session::text AND intake_draft_id IS NULL;
IF (v_receipt->>'created')::boolean IS TRUE THEN
INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
VALUES(v_tenant,'voice-intake','field_service.inquiry.opened','intake_draft',v_intake,jsonb_build_object('sessionId',p_session,'ticketId',v_receipt->>'ticketId'));
END IF;
RETURN
jsonb_build_object('status','open','intakeId',v_intake,'ticketId',v_receipt->>'ticketId','reference',v_receipt->>'reference');
END $$;
""".replace("%", "%%")
        )
    )


def downgrade() -> None:
    raise RuntimeError("caller_privacy_gate_cannot_be_removed_by_automatic_downgrade")
