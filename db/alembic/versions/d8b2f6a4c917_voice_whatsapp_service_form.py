"""Compatibility foundation for the digital service-form workflow.

Adds the form-mode policy shape and the internal case constructor. The
following e9c5b8d2a401 migration restricts this constructor to explicit web-form
submission, prevents opening cases from phone/WhatsApp replies, and enforces
the phone's name-plus-fault boundary. Deploy the complete migration chain;
this intermediate definition is not the final customer workflow.

It also repairs the validator's template-name check. PostgreSQL regular
expressions allow repetition bounds only up to 255, so ``{1,512}`` raised an
error whenever a follow-up template was configured: no tenant could save one.
The length is now checked separately. A downgrade deliberately keeps the
repair.

Revision ID: d8b2f6a4c917
Revises: c3e7a91d5f20
"""

# ruff: noqa: E501, S608 -- SQL assembled only from migration-owned constants.
from alembic import op

revision = "d8b2f6a4c917"
down_revision = "c3e7a91d5f20"
branch_labels = None
depends_on = None

_FORM_FIELDS = "'serviceLocation','storeName','customerName','faultDescription','chainName'"


def _validator(follow_up_keys: str, follow_up_checks: str) -> str:
    return (
        r"""
CREATE OR REPLACE FUNCTION service.validate_workflow_policy(p_policy jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
      DECLARE v jsonb; v_item jsonb;
      BEGIN
        IF p_policy IS NULL OR jsonb_typeof(p_policy)<>'object' THEN RETURN false; END IF;
        IF p_policy->>'version' IS DISTINCT FROM '1' OR jsonb_typeof(p_policy->'selfAssignmentEnabled') IS DISTINCT FROM 'boolean'
          OR coalesce(p_policy->>'photoPolicy','') NOT IN ('optional','requested','required')
          OR jsonb_typeof(p_policy->'requiredIntakeFields') IS DISTINCT FROM 'array'
          OR jsonb_typeof(p_policy->'requiredReportFields') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_policy) key WHERE key NOT IN ('version','selfAssignmentEnabled','photoPolicy','requiredIntakeFields','requiredReportFields','inquiry','whatsappFollowUp','emergency','preparation','attachmentCategories','evidence')) THEN RETURN false; END IF;
        IF NOT (p_policy->'requiredIntakeFields' ? 'faultDescription') OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_policy->'requiredIntakeFields') key WHERE jsonb_typeof(key)<>'string' OR key#>>'{}' NOT IN ('customerName','customerPhone','nationalId','chainName','storeName','serviceLocation','faultDescription','exactFailure','warrantyStatus','callbackNumber','urgency')) THEN RETURN false; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_policy->'requiredReportFields') key WHERE jsonb_typeof(key)<>'string' OR key#>>'{}' NOT IN ('diagnosis','workPerformed','partReplaced','arrivalSignature','departureSignature','faultPhoto','modulePhoto')) THEN RETURN false; END IF;
        IF NOT ((SELECT count(*)=count(DISTINCT key) FROM jsonb_array_elements_text(p_policy->'requiredIntakeFields') key)
          AND (SELECT count(*)=count(DISTINCT key) FROM jsonb_array_elements_text(p_policy->'requiredReportFields') key)) THEN RETURN false; END IF;

        v := p_policy->'inquiry';
        IF v IS NOT NULL AND (jsonb_typeof(v)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k<>'openOnFirstContact')
          OR jsonb_typeof(v->'openOnFirstContact') IS DISTINCT FROM 'boolean') THEN RETURN false; END IF;

        v := p_policy->'whatsappFollowUp';
        IF v IS NOT NULL THEN
          IF jsonb_typeof(v)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ("""
        + follow_up_keys
        + r"""))
            OR jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v->'requestPhoto') IS DISTINCT FROM 'boolean'
            OR coalesce(v->>'trigger','') NOT IN ('intake_saved','call_ended')
            OR coalesce(v->>'consent','') NOT IN ('in_call_agreement','existing_only')
            OR (v ? 'templateName') <> (v ? 'templateLanguage') THEN RETURN false; END IF;
          IF v ? 'templateName' AND (jsonb_typeof(v->'templateName')<>'string' OR char_length(v->>'templateName') NOT BETWEEN 1 AND 512 OR v->>'templateName' !~ '^[a-z0-9_]+$'
            OR jsonb_typeof(v->'templateLanguage')<>'string' OR v->>'templateLanguage' !~ '^[a-z]{2,3}(_[A-Z]{2})?$') THEN RETURN false; END IF;
          IF v ? 'templateParameters' AND (NOT (v ? 'templateName') OR jsonb_typeof(v->'templateParameters')<>'array' OR jsonb_array_length(v->'templateParameters')>5
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'templateParameters') p WHERE jsonb_typeof(p)<>'string' OR p#>>'{}' NOT IN ('customerName','reference','faultSummary','businessName'))) THEN RETURN false; END IF;"""
        + follow_up_checks
        + r"""
        END IF;

        v := p_policy->'emergency';
        IF v IS NOT NULL THEN
          IF jsonb_typeof(v)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('enabled','label','manualRedCall','transferTo','fallback'))
            OR jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v->'manualRedCall') IS DISTINCT FROM 'boolean'
            OR jsonb_typeof(v->'label') IS DISTINCT FROM 'string' OR char_length(btrim(v->>'label')) NOT BETWEEN 1 AND 40
            OR coalesce(v->>'fallback','') NOT IN ('urgent_followup','notify_staff') THEN RETURN false; END IF;
          IF v ? 'transferTo' AND (jsonb_typeof(v->'transferTo')<>'string' OR v->>'transferTo' !~ '^\+[1-9][0-9]{7,14}$') THEN RETURN false; END IF;
        END IF;

        v := p_policy->'preparation';
        IF v IS NOT NULL THEN
          IF jsonb_typeof(v)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('enabled','instructions','requireAcknowledgement','checklist'))
            OR jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v->'requireAcknowledgement') IS DISTINCT FROM 'boolean'
            OR jsonb_typeof(v->'checklist') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'checklist')>30 THEN RETURN false; END IF;
          IF v ? 'instructions' AND (jsonb_typeof(v->'instructions')<>'string' OR char_length(v->>'instructions')>2000) THEN RETURN false; END IF;
          FOR v_item IN SELECT value FROM jsonb_array_elements(v->'checklist') LOOP
            IF jsonb_typeof(v_item)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('key','label','required'))
              OR coalesce(v_item->>'key','') !~ '^[a-z0-9_]{1,40}$' OR jsonb_typeof(v_item->'label') IS DISTINCT FROM 'string'
              OR char_length(btrim(v_item->>'label')) NOT BETWEEN 1 AND 160 OR jsonb_typeof(v_item->'required') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
          END LOOP;
          IF (SELECT count(*)<>count(DISTINCT item->>'key') FROM jsonb_array_elements(v->'checklist') item) THEN RETURN false; END IF;
        END IF;

        v := p_policy->'attachmentCategories';
        IF v IS NOT NULL THEN
          IF jsonb_typeof(v)<>'array' OR jsonb_array_length(v)>12 THEN RETURN false; END IF;
          FOR v_item IN SELECT value FROM jsonb_array_elements(v) LOOP
            IF jsonb_typeof(v_item)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('key','label','accept'))
              OR coalesce(v_item->>'key','') !~ '^[a-z][a-z0-9_]{1,31}$' OR v_item->>'key' IN ('fault','module','product_label','repair','environment','document','customer_photo','arrival_signature','departure_signature','before_photo','after_photo','tenant_document')
              OR jsonb_typeof(v_item->'label') IS DISTINCT FROM 'string' OR char_length(btrim(v_item->>'label')) NOT BETWEEN 1 AND 40
              OR jsonb_typeof(v_item->'accept') IS DISTINCT FROM 'array' OR jsonb_array_length(v_item->'accept') NOT BETWEEN 1 AND 2
              OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_item->'accept') a WHERE jsonb_typeof(a)<>'string' OR a#>>'{}' NOT IN ('image','pdf')) THEN RETURN false; END IF;
          END LOOP;
          IF (SELECT count(*)<>count(DISTINCT item->>'key') FROM jsonb_array_elements(v) item) THEN RETURN false; END IF;
        END IF;

        v := p_policy->'evidence';
        IF v IS NOT NULL AND (jsonb_typeof(v)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('beforePhotoRequired','afterPhotoRequired'))
          OR jsonb_typeof(v->'beforePhotoRequired') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v->'afterPhotoRequired') IS DISTINCT FROM 'boolean') THEN RETURN false; END IF;
        RETURN true;
      END $$
"""
    )


_PREVIOUS_FOLLOW_UP_KEYS = "'enabled','trigger','requestPhoto','consent','templateName','templateLanguage','templateParameters'"
_FOLLOW_UP_KEYS = "'enabled','trigger','requestPhoto','consent','mode','formFields','templateName','templateLanguage','templateParameters'"
_FOLLOW_UP_CHECKS = f"""
          IF v ? 'mode' AND (jsonb_typeof(v->'mode')<>'string' OR v->>'mode' NOT IN ('summary','form')) THEN RETURN false; END IF;
          IF v ? 'formFields' AND (v->>'mode' IS DISTINCT FROM 'form' OR jsonb_typeof(v->'formFields')<>'array'
            OR jsonb_array_length(v->'formFields') NOT BETWEEN 1 AND 5
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'formFields') f WHERE jsonb_typeof(f)<>'string' OR f#>>'{{}}' NOT IN ({_FORM_FIELDS}))
            OR (SELECT count(*)<>count(DISTINCT f) FROM jsonb_array_elements_text(v->'formFields') f)) THEN RETURN false; END IF;"""


def _request_followup(form_check: str) -> str:
    return (
        r"""
CREATE OR REPLACE FUNCTION service.request_intake_followup(p_session uuid,p_customer_agreed boolean) RETURNS jsonb
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
        IF coalesce((v_policy#>>'{whatsappFollowUp,enabled}')::boolean,false) IS NOT TRUE THEN
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
          IF coalesce(p_customer_agreed,false) AND v_policy#>>'{whatsappFollowUp,consent}'='in_call_agreement' THEN
            UPDATE crm.contacts SET whatsapp_consent='granted',updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=v_contact.id AND whatsapp_consent='unknown';
            INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
              VALUES(v_tenant,'voice-intake','crm.contact.whatsapp_consent_granted','contact',v_contact.id,
                jsonb_build_object('source','voice_call','sessionId',p_session,'purpose','service_followup','intakeId',v_intake));
          ELSE
            UPDATE service.intake_drafts SET followup_status='blocked_consent',followup_requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=v_intake;
            RETURN jsonb_build_object('status','unavailable','reason','consent_required','intakeId',v_intake);
          END IF;
        END IF;"""
        + form_check
        + r"""
        UPDATE service.intake_drafts SET followup_status=CASE WHEN followup_status IN ('not_requested','blocked_consent','no_recipient') THEN 'requested' ELSE followup_status END,
          followup_requested_at=coalesce(followup_requested_at,clock_timestamp()),updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=v_intake;
        IF v_policy#>>'{whatsappFollowUp,trigger}'='intake_saved' THEN
          v_job:=service.enqueue_intake_followup(v_tenant,v_intake,'in_call_request');
          RETURN jsonb_build_object('status','queued','jobId',v_job,'intakeId',v_intake,'caseId',v_context->>'caseId');
        END IF;
        RETURN jsonb_build_object('status','deferred','intakeId',v_intake,'caseId',v_context->>'caseId','sendsWhen','call_ended');
      END $$
"""
    )


# Business-initiated text needs an open customer-service window, and the form
# is sent within minutes. Without an approved template and such a window the
# message would be refused, so the agent must not promise it.
_FORM_DELIVERY_CHECK = r"""
        IF v_policy#>>'{whatsappFollowUp,mode}'='form' AND v_policy#>>'{whatsappFollowUp,templateName}' IS NULL
          AND NOT EXISTS(SELECT 1 FROM messaging.conversations conversation
            JOIN messaging.channels channel ON channel.tenant_id=conversation.tenant_id AND channel.id=conversation.channel_id
            WHERE conversation.tenant_id=v_tenant AND conversation.contact_id=v_contact.id
              AND channel.kind='whatsapp' AND channel.status='active' AND conversation.removed_from_inbox_at IS NULL
              AND conversation.customer_service_window_expires_at>clock_timestamp()+interval '30 minutes') THEN
          UPDATE service.intake_drafts SET followup_status='blocked_window',followup_requested_at=clock_timestamp(),
            followup_error_safe='customer_service_window_closed',updated_at=clock_timestamp()
            WHERE tenant_id=v_tenant AND id=v_intake AND followup_status<>'admitted';
          RETURN jsonb_build_object('status','unavailable','reason','whatsapp_template_required','intakeId',v_intake);
        END IF;"""


def _execute(sql: str) -> None:
    # Escape colons so string literals such as ':voice-service:' are not
    # parsed as bind parameters, exactly as the original definitions were run.
    op.execute(sql.replace(":", r"\:"))


# A phone intake completed on WhatsApp opens its case exactly as a call that
# collected everything does (service.capture_service_intake): the caller's
# contact is the customer, the store is found or registered in the directory,
# the call and conversation are linked and the customer's photos attached.
# Only a form intake whose form was sent, and only once nothing is missing.
_OPEN_FORM_CASE = r"""
CREATE FUNCTION service.open_form_intake_case(p_intake uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_intake service.intake_drafts%ROWTYPE; v_policy jsonb; v_fields jsonb;
        v_contact uuid; v_location uuid; v_chain uuid; v_case uuid; v_reference text; v_ticket support.tickets%ROWTYPE;
      BEGIN
        IF NOT service.field_service_enabled() THEN RAISE EXCEPTION 'field service is not enabled' USING ERRCODE='42501'; END IF;
        SELECT * INTO v_intake FROM service.intake_drafts WHERE tenant_id=v_tenant AND id=p_intake FOR UPDATE;
        IF NOT FOUND OR v_intake.source_session_id IS NULL OR v_intake.followup_status<>'admitted'
          OR v_intake.workflow_policy#>>'{whatsappFollowUp,mode}' IS DISTINCT FROM 'form' THEN
          RAISE EXCEPTION 'not a phone intake waiting for its WhatsApp form' USING ERRCODE='42501'; END IF;
        SELECT id,reference INTO v_case,v_reference FROM service.cases WHERE tenant_id=v_tenant AND intake_draft_id=p_intake;
        IF FOUND THEN RETURN jsonb_build_object('status','opened','caseId',v_case,'reference',v_reference,'created',false); END IF;
        IF v_intake.status NOT IN ('collecting','awaiting_confirmation') THEN
          RAISE EXCEPTION 'the intake is closed' USING ERRCODE='42501'; END IF;
        v_policy:=v_intake.workflow_policy; v_fields:=v_intake.collected_fields;
        IF jsonb_array_length(service.intake_missing_fields(v_fields,v_policy))>0
          OR (v_policy->>'photoPolicy'='required' AND NOT service.intake_has_photo(p_intake)) THEN
          RETURN jsonb_build_object('status','incomplete'); END IF;
        v_contact:=coalesce(v_intake.customer_contact_id,v_intake.reporting_contact_id);
        IF v_fields->>'customerName' IS NOT NULL THEN
          UPDATE crm.contacts SET name=v_fields->>'customerName',updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND id=v_contact AND name ~ '^\+?[0-9 ()-]{7,}$';
        END IF;
        IF v_fields->>'storeId' IS NOT NULL THEN
          SELECT id INTO v_location FROM crm.service_locations WHERE tenant_id=v_tenant AND id=(v_fields->>'storeId')::uuid AND archived_at IS NULL;
        END IF;
        IF v_location IS NULL AND v_fields->>'storeName' IS NOT NULL THEN
          IF v_fields->>'chainName' IS NOT NULL THEN
            SELECT id INTO v_chain FROM crm.service_chains WHERE tenant_id=v_tenant AND lower(name)=lower(v_fields->>'chainName') AND active;
            IF v_chain IS NULL THEN INSERT INTO crm.service_chains(tenant_id,name) VALUES(v_tenant,v_fields->>'chainName') ON CONFLICT(tenant_id,lower(name)) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO v_chain; END IF;
          END IF;
          SELECT id INTO v_location FROM crm.service_locations WHERE tenant_id=v_tenant AND chain_id IS NOT DISTINCT FROM v_chain AND lower(name)=lower(v_fields->>'storeName') AND archived_at IS NULL ORDER BY id LIMIT 1;
          IF v_location IS NULL THEN INSERT INTO crm.service_locations(tenant_id,customer_contact_id,chain_id,name,address) VALUES(v_tenant,v_contact,v_chain,v_fields->>'storeName',v_fields->>'serviceAddress') RETURNING id INTO v_location; END IF;
        END IF;
        SELECT * INTO v_ticket FROM support.tickets WHERE tenant_id=v_tenant AND attachment_key='voice-session:'||v_intake.source_session_id::text;
        v_case:=gen_random_uuid(); v_reference:='FS-'||to_char(CURRENT_TIMESTAMP,'YYYY')||'-'||upper(left(replace(v_case::text,'-',''),8));
        INSERT INTO service.cases(id,tenant_id,reference,customer_contact_id,reporting_contact_id,service_location_id,intake_draft_id,conversation_id,title,fault_description,product_type,product_model,serial_number,source,priority)
        VALUES(v_case,v_tenant,v_reference,v_contact,v_intake.reporting_contact_id,v_location,p_intake,v_intake.conversation_id,left(v_fields->>'faultDescription',200),left((v_fields->>'faultDescription')||CASE WHEN v_fields->>'exactFailure' IS NULL THEN '' ELSE E'\n'||(v_fields->>'exactFailure') END,10000),v_fields->>'productType',v_fields->>'productModel',v_fields->>'serialNumber','voice',
          CASE WHEN v_ticket.emergency_at IS NOT NULL THEN 'urgent' WHEN v_fields->>'urgency' IN ('low','normal','high','urgent') THEN v_fields->>'urgency' ELSE 'normal' END);
        UPDATE service.cases SET workflow_policy=service.redact_workflow_policy(v_policy) WHERE tenant_id=v_tenant AND id=v_case;
        INSERT INTO service.case_calls(tenant_id,case_id,session_id,relationship) VALUES(v_tenant,v_case,v_intake.source_session_id,'intake') ON CONFLICT DO NOTHING;
        IF v_intake.conversation_id IS NOT NULL THEN
          INSERT INTO service.case_conversations(tenant_id,case_id,conversation_id,relationship) VALUES(v_tenant,v_case,v_intake.conversation_id,'intake') ON CONFLICT DO NOTHING;
        END IF;
        INSERT INTO service.report_attachments(tenant_id,case_id,message_id,object_id,category,source,processing_status)
          SELECT v_tenant,v_case,m.id,m.object_id,CASE WHEN m.content_type='image' THEN 'customer_photo' ELSE 'document' END,'customer','available'
          FROM service.intake_messages im JOIN messaging.messages m ON m.tenant_id=im.tenant_id AND m.id=im.message_id
          JOIN objects.object_metadata o ON o.tenant_id=m.tenant_id AND o.id=m.object_id
          WHERE im.tenant_id=v_tenant AND im.intake_draft_id=p_intake AND m.direction='inbound' AND m.content_type IN ('image','document') AND o.status='available' AND o.deleted_at IS NULL ON CONFLICT DO NOTHING;
        INSERT INTO service.case_status_history(tenant_id,case_id,to_status,actor_service) VALUES(v_tenant,v_case,'awaiting_scheduling','voice-whatsapp-form');
        UPDATE service.intake_drafts SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND id=p_intake;
        INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
          VALUES(v_tenant,'voice-whatsapp-form','field_service.intake.confirmed','service_case',v_case,jsonb_build_object('sessionId',v_intake.source_session_id,'intakeId',p_intake));
        RETURN jsonb_build_object('status','opened','caseId',v_case,'reference',v_reference,'created',true);
      END $$
"""

# Merging the WhatsApp answers re-checks who the customer is by phone, which
# joins the protected-ID blind index. Only the matching columns are readable;
# no protected value, document or address is exposed to the worker.
_PROFILE_MATCH_GRANT = (
    "SELECT (tenant_id, contact_id, national_id_blind_index) ON crm.customer_profiles"
)


def upgrade() -> None:
    _execute(_validator(_FOLLOW_UP_KEYS, _FOLLOW_UP_CHECKS))
    _execute(_request_followup(_FORM_DELIVERY_CHECK))
    _execute(_OPEN_FORM_CASE)
    op.execute("REVOKE ALL ON FUNCTION service.open_form_intake_case(uuid) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION service.open_form_intake_case(uuid) TO platform_messaging"
    )
    op.execute(f"GRANT {_PROFILE_MATCH_GRANT} TO platform_messaging")


def downgrade() -> None:
    op.execute(f"REVOKE {_PROFILE_MATCH_GRANT} FROM platform_messaging")
    op.execute("DROP FUNCTION service.open_form_intake_case(uuid)")
    _execute(_request_followup(""))
    _execute(_validator(_PREVIOUS_FOLLOW_UP_KEYS, ""))
