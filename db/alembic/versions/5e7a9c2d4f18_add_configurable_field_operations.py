"""Configurable field operations: red calls, technician timeline, preparation and evidence.

Every capability is optional workflow policy on the existing Field Service
feature configuration. Absent keys keep today's behaviour exactly, so a tenant
that has not enabled them sees no change. Security boundaries are not policy:
authorization, tenant isolation and redaction of routing contacts are enforced
here regardless of configuration.

Revision ID: 5e7a9c2d4f18
Revises: 3f5c8b1d7e42
"""

# ruff: noqa: E501, S608 -- SQL uses migration-owned constants only.
from collections.abc import Sequence

from alembic import op

revision: str = "5e7a9c2d4f18"
down_revision: str | None = "3f5c8b1d7e42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LEGACY_POLICY = '{"version":1,"requiredIntakeFields":["customerName","customerPhone","nationalId","storeName","serviceLocation","faultDescription","warrantyStatus"],"photoPolicy":"optional","selfAssignmentEnabled":false,"requiredReportFields":["diagnosis","workPerformed","partReplaced","arrivalSignature","departureSignature","faultPhoto","modulePhoto"]}'
BUILT_IN_CATEGORIES = "'fault','module','product_label','repair','environment','document','customer_photo','arrival_signature','departure_signature','before_photo','after_photo','tenant_document'"


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
    _policy()
    _red_calls()
    _technician_timeline()
    _preparation()
    _attachments_and_evidence()
    _grants()


def _policy() -> None:
    _execute(f"""
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
        IF NOT (p_policy->'requiredIntakeFields' ? 'faultDescription') OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_policy->'requiredIntakeFields') key WHERE jsonb_typeof(key)<>'string' OR key#>>'{{}}' NOT IN ('customerName','customerPhone','nationalId','chainName','storeName','serviceLocation','faultDescription','exactFailure','warrantyStatus','callbackNumber','urgency')) THEN RETURN false; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_policy->'requiredReportFields') key WHERE jsonb_typeof(key)<>'string' OR key#>>'{{}}' NOT IN ('diagnosis','workPerformed','partReplaced','arrivalSignature','departureSignature','faultPhoto','modulePhoto')) THEN RETURN false; END IF;
        IF NOT ((SELECT count(*)=count(DISTINCT key) FROM jsonb_array_elements_text(p_policy->'requiredIntakeFields') key)
          AND (SELECT count(*)=count(DISTINCT key) FROM jsonb_array_elements_text(p_policy->'requiredReportFields') key)) THEN RETURN false; END IF;

        v := p_policy->'inquiry';
        IF v IS NOT NULL AND (jsonb_typeof(v)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k<>'openOnFirstContact')
          OR jsonb_typeof(v->'openOnFirstContact') IS DISTINCT FROM 'boolean') THEN RETURN false; END IF;

        v := p_policy->'whatsappFollowUp';
        IF v IS NOT NULL THEN
          IF jsonb_typeof(v)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('enabled','trigger','requestPhoto','consent','templateName','templateLanguage','templateParameters'))
            OR jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v->'requestPhoto') IS DISTINCT FROM 'boolean'
            OR coalesce(v->>'trigger','') NOT IN ('intake_saved','call_ended')
            OR coalesce(v->>'consent','') NOT IN ('in_call_agreement','existing_only')
            OR (v ? 'templateName') <> (v ? 'templateLanguage') THEN RETURN false; END IF;
          IF v ? 'templateName' AND (jsonb_typeof(v->'templateName')<>'string' OR v->>'templateName' !~ '^[a-z0-9_]{{1,512}}$'
            OR jsonb_typeof(v->'templateLanguage')<>'string' OR v->>'templateLanguage' !~ '^[a-z]{{2,3}}(_[A-Z]{{2}})?$') THEN RETURN false; END IF;
          IF v ? 'templateParameters' AND (NOT (v ? 'templateName') OR jsonb_typeof(v->'templateParameters')<>'array' OR jsonb_array_length(v->'templateParameters')>5
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'templateParameters') p WHERE jsonb_typeof(p)<>'string' OR p#>>'{{}}' NOT IN ('customerName','reference','faultSummary','businessName'))) THEN RETURN false; END IF;
        END IF;

        v := p_policy->'emergency';
        IF v IS NOT NULL THEN
          IF jsonb_typeof(v)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('enabled','label','manualRedCall','transferTo','fallback'))
            OR jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v->'manualRedCall') IS DISTINCT FROM 'boolean'
            OR jsonb_typeof(v->'label') IS DISTINCT FROM 'string' OR char_length(btrim(v->>'label')) NOT BETWEEN 1 AND 40
            OR coalesce(v->>'fallback','') NOT IN ('urgent_followup','notify_staff') THEN RETURN false; END IF;
          IF v ? 'transferTo' AND (jsonb_typeof(v->'transferTo')<>'string' OR v->>'transferTo' !~ '^\\+[1-9][0-9]{{7,14}}$') THEN RETURN false; END IF;
        END IF;

        v := p_policy->'preparation';
        IF v IS NOT NULL THEN
          IF jsonb_typeof(v)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('enabled','instructions','requireAcknowledgement','checklist'))
            OR jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v->'requireAcknowledgement') IS DISTINCT FROM 'boolean'
            OR jsonb_typeof(v->'checklist') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'checklist')>30 THEN RETURN false; END IF;
          IF v ? 'instructions' AND (jsonb_typeof(v->'instructions')<>'string' OR char_length(v->>'instructions')>2000) THEN RETURN false; END IF;
          FOR v_item IN SELECT value FROM jsonb_array_elements(v->'checklist') LOOP
            IF jsonb_typeof(v_item)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('key','label','required'))
              OR coalesce(v_item->>'key','') !~ '^[a-z0-9_]{{1,40}}$' OR jsonb_typeof(v_item->'label') IS DISTINCT FROM 'string'
              OR char_length(btrim(v_item->>'label')) NOT BETWEEN 1 AND 160 OR jsonb_typeof(v_item->'required') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
          END LOOP;
          IF (SELECT count(*)<>count(DISTINCT item->>'key') FROM jsonb_array_elements(v->'checklist') item) THEN RETURN false; END IF;
        END IF;

        v := p_policy->'attachmentCategories';
        IF v IS NOT NULL THEN
          IF jsonb_typeof(v)<>'array' OR jsonb_array_length(v)>12 THEN RETURN false; END IF;
          FOR v_item IN SELECT value FROM jsonb_array_elements(v) LOOP
            IF jsonb_typeof(v_item)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('key','label','accept'))
              OR coalesce(v_item->>'key','') !~ '^[a-z][a-z0-9_]{{1,31}}$' OR v_item->>'key' IN ({BUILT_IN_CATEGORIES})
              OR jsonb_typeof(v_item->'label') IS DISTINCT FROM 'string' OR char_length(btrim(v_item->>'label')) NOT BETWEEN 1 AND 40
              OR jsonb_typeof(v_item->'accept') IS DISTINCT FROM 'array' OR jsonb_array_length(v_item->'accept') NOT BETWEEN 1 AND 2
              OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_item->'accept') a WHERE jsonb_typeof(a)<>'string' OR a#>>'{{}}' NOT IN ('image','pdf')) THEN RETURN false; END IF;
          END LOOP;
          IF (SELECT count(*)<>count(DISTINCT item->>'key') FROM jsonb_array_elements(v) item) THEN RETURN false; END IF;
        END IF;

        v := p_policy->'evidence';
        IF v IS NOT NULL AND (jsonb_typeof(v)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('beforePhotoRequired','afterPhotoRequired'))
          OR jsonb_typeof(v->'beforePhotoRequired') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v->'afterPhotoRequired') IS DISTINCT FROM 'boolean') THEN RETURN false; END IF;
        RETURN true;
      END $$;

      -- The routing contact is administrator-approved configuration, never
      -- workflow data: every reader except the voice routing function gets
      -- the policy without it, including pinned case/intake snapshots.
      CREATE FUNCTION service.redact_workflow_policy(p_policy jsonb) RETURNS jsonb
      LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
        SELECT CASE WHEN p_policy ? 'emergency' THEN p_policy #- '{{emergency,transferTo}}' ELSE p_policy END
      $$;
      CREATE OR REPLACE FUNCTION service.current_workflow_policy() RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT service.redact_workflow_policy(coalesce((SELECT configuration->'workflow' FROM platform.tenant_feature_entitlements
          WHERE tenant_id=platform.current_tenant_id() AND feature_key='field_service'),'{LEGACY_POLICY}'::jsonb))
      $$;
      CREATE OR REPLACE FUNCTION service.pin_intake_workflow() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        SELECT service.redact_workflow_policy(coalesce((SELECT configuration->'workflow' FROM platform.tenant_feature_entitlements WHERE tenant_id=NEW.tenant_id AND feature_key='field_service'),'{LEGACY_POLICY}'::jsonb)) INTO NEW.workflow_policy;
        IF TG_TABLE_NAME='cases' THEN
          IF NEW.intake_draft_id IS NOT NULL THEN
            SELECT service.redact_workflow_policy(coalesce(workflow_policy,'{LEGACY_POLICY}'::jsonb)) INTO NEW.workflow_policy FROM service.intake_drafts WHERE tenant_id=NEW.tenant_id AND id=NEW.intake_draft_id;
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      -- The policy of the case itself, for its workflow gates.
      CREATE FUNCTION service.case_workflow_policy(p_tenant uuid,p_case uuid) RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT coalesce(workflow_policy,'{LEGACY_POLICY}'::jsonb) FROM service.cases WHERE tenant_id=p_tenant AND id=p_case
      $$;
    """)


def _red_calls() -> None:
    _execute("""
      ALTER TABLE support.tickets
        ADD COLUMN emergency_at timestamptz,
        ADD COLUMN emergency_reason text,
        ADD COLUMN emergency_source text,
        ADD COLUMN emergency_marked_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        ADD CONSTRAINT ck_support_ticket_emergency_shape CHECK (
          num_nonnulls(emergency_at,emergency_reason,emergency_source) IN (0,3)
          AND (emergency_reason IS NULL OR char_length(btrim(emergency_reason)) BETWEEN 1 AND 500)
          AND (emergency_source IS NULL OR emergency_source IN ('voice','manual'))
          AND (emergency_at IS NULL OR priority='urgent'));
      CREATE INDEX ix_support_tickets_emergency ON support.tickets(tenant_id,emergency_at DESC) WHERE emergency_at IS NOT NULL AND status='open';

      -- Emergency marking is one audited transition on the existing inquiry.
      -- The label shown to people is tenant configuration, the mechanism is not.
      CREATE FUNCTION support.mark_ticket_emergency(p_ticket uuid,p_reason text,p_source text) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_role text:=coalesce(current_setting('app.current_role',true),'');
        v_policy jsonb; v_ticket support.tickets%ROWTYPE; v_reason text:=btrim(regexp_replace(coalesce(p_reason,''),'\\s+',' ','g')); v_sequence integer;
      BEGIN
        IF v_tenant IS NULL OR NOT platform.current_tenant_active() OR NOT platform.current_tenant_feature_enabled('tickets') THEN
          RAISE EXCEPTION 'emergency marking is unavailable' USING ERRCODE='42501'; END IF;
        v_policy:=service.current_workflow_policy();
        IF coalesce((v_policy#>>'{emergency,enabled}')::boolean,false) IS NOT TRUE THEN
          RAISE EXCEPTION 'emergency handling is not enabled for this tenant' USING ERRCODE='42501'; END IF;
        IF p_source='manual' THEN
          IF v_role NOT IN ('owner','admin','agent') OR platform.current_user_id() IS NULL THEN
            RAISE EXCEPTION 'an authorized dispatcher is required' USING ERRCODE='42501'; END IF;
          IF coalesce((v_policy#>>'{emergency,manualRedCall}')::boolean,false) IS NOT TRUE THEN
            RAISE EXCEPTION 'manual emergency calls are not enabled for this tenant' USING ERRCODE='42501'; END IF;
        ELSIF p_source<>'voice' THEN
          RAISE EXCEPTION 'unsupported emergency source' USING ERRCODE='22023';
        END IF;
        IF char_length(v_reason) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'an urgency reason is required' USING ERRCODE='22023'; END IF;
        SELECT * INTO v_ticket FROM support.tickets WHERE tenant_id=v_tenant AND id=p_ticket FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'inquiry not found' USING ERRCODE='P0002'; END IF;
        IF v_ticket.status<>'open' THEN RAISE EXCEPTION 'a closed inquiry cannot be marked as an emergency' USING ERRCODE='23514'; END IF;
        IF v_ticket.emergency_at IS NOT NULL THEN
          RETURN jsonb_build_object('ticketId',v_ticket.id,'emergencyAt',v_ticket.emergency_at,'created',false);
        END IF;
        UPDATE support.tickets SET priority='urgent',emergency_at=clock_timestamp(),emergency_reason=v_reason,emergency_source=p_source,
          emergency_marked_by_user_id=CASE WHEN p_source='manual' THEN platform.current_user_id() END,
          next_event_sequence=next_event_sequence+1,last_activity_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=v_tenant AND id=p_ticket RETURNING next_event_sequence INTO v_sequence;
        INSERT INTO support.ticket_events(tenant_id,ticket_id,sequence,kind,actor_kind,actor_user_id,visibility,summary_safe,evidence)
          VALUES(v_tenant,p_ticket,v_sequence,'escalation',CASE WHEN p_source='manual' THEN 'human' ELSE 'ai' END,
            CASE WHEN p_source='manual' THEN platform.current_user_id() END,'internal',
            left(coalesce(v_policy#>>'{emergency,label}','Emergency')||': '||v_reason,2000),
            jsonb_build_object('escalation','marked','source',p_source,'previousPriority',v_ticket.priority));
        INSERT INTO audit.records(tenant_id,actor_user_id,actor_service,action,target_type,target_id,metadata)
          VALUES(v_tenant,CASE WHEN p_source='manual' THEN platform.current_user_id() END,CASE WHEN p_source='voice' THEN 'voice-intake' END,
            'support.ticket.emergency_marked','support_ticket',p_ticket,jsonb_build_object('source',p_source,'previousPriority',v_ticket.priority));
        RETURN jsonb_build_object('ticketId',p_ticket,'created',true);
      END $$;

      -- Escalation outcomes are facts reported by the component that tried,
      -- appended to the same timeline. Nothing here can claim an answer.
      CREATE FUNCTION support.record_ticket_escalation(p_ticket uuid,p_outcome text,p_actor_service text) RETURNS integer
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_sequence integer;
      BEGIN
        IF p_outcome NOT IN ('transfer_initiated','transfer_failed','no_transfer_target','caller_disconnected','fallback_urgent_followup','fallback_staff_notified') THEN
          RAISE EXCEPTION 'unsupported escalation outcome' USING ERRCODE='22023'; END IF;
        UPDATE support.tickets SET next_event_sequence=next_event_sequence+1,last_activity_at=clock_timestamp(),updated_at=clock_timestamp(),
          next_action=CASE WHEN p_outcome IN ('transfer_failed','no_transfer_target','caller_disconnected','fallback_urgent_followup','fallback_staff_notified')
            THEN 'urgent_callback' ELSE next_action END,
          next_action_due_at=CASE WHEN p_outcome IN ('transfer_failed','no_transfer_target','caller_disconnected','fallback_urgent_followup','fallback_staff_notified')
            THEN clock_timestamp() ELSE next_action_due_at END,
          stage=CASE WHEN status='open' AND p_outcome<>'transfer_initiated' THEN 'awaiting_human' ELSE stage END,
          handling_mode=CASE WHEN status='open' AND p_outcome<>'transfer_initiated' THEN 'human' ELSE handling_mode END
          WHERE tenant_id=v_tenant AND id=p_ticket AND emergency_at IS NOT NULL RETURNING next_event_sequence INTO v_sequence;
        IF v_sequence IS NULL THEN RAISE EXCEPTION 'emergency inquiry not found' USING ERRCODE='P0002'; END IF;
        INSERT INTO support.ticket_events(tenant_id,ticket_id,sequence,kind,actor_kind,visibility,summary_safe,evidence)
          VALUES(v_tenant,p_ticket,v_sequence,'escalation','system','internal',
            CASE p_outcome WHEN 'transfer_initiated' THEN 'Transfer to the on-call contact was initiated; an answer is not confirmed.'
              WHEN 'transfer_failed' THEN 'Transfer to the on-call contact failed; urgent follow-up is required.'
              WHEN 'no_transfer_target' THEN 'No on-call transfer contact is configured; urgent follow-up is required.'
              WHEN 'caller_disconnected' THEN 'The caller disconnected before escalation completed; urgent follow-up is required.'
              WHEN 'fallback_urgent_followup' THEN 'Urgent follow-up was left for staff.'
              ELSE 'Staff were notified of the urgent inquiry.' END,
            jsonb_build_object('escalation',p_outcome,'actorService',left(coalesce(p_actor_service,'system'),60)));
        IF p_outcome<>'transfer_initiated' THEN
          INSERT INTO messaging.notifications(tenant_id,user_id,type,title,body,reference_type,reference_id)
          SELECT v_tenant,recipient.user_id,'support.emergency','Urgent inquiry needs follow-up',
            (SELECT left(reference||' · '||subject,240) FROM support.tickets WHERE tenant_id=v_tenant AND id=p_ticket),'support_ticket',p_ticket
          FROM platform.current_tenant_notification_recipients() recipient;
        END IF;
        RETURN v_sequence;
      END $$;
    """)


def _technician_timeline() -> None:
    _execute("""
      ALTER TABLE service.visits
        ADD COLUMN en_route_at timestamptz,
        ADD COLUMN work_started_at timestamptz,
        ADD COLUMN work_completed_at timestamptz,
        ADD CONSTRAINT ck_visit_work_order CHECK (
          (work_started_at IS NULL OR arrival_at IS NOT NULL)
          AND (work_completed_at IS NULL OR work_started_at IS NOT NULL)
          AND (work_completed_at IS NULL OR work_completed_at >= work_started_at));
      CREATE TABLE service.visit_time_corrections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
        visit_id uuid NOT NULL,
        field text NOT NULL CHECK (field IN ('en_route_at','arrival_at','work_started_at','work_completed_at','departure_at')),
        previous_value timestamptz,
        new_value timestamptz NOT NULL,
        reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
        corrected_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
        corrected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (tenant_id,id),
        FOREIGN KEY (tenant_id,visit_id) REFERENCES service.visits(tenant_id,id) ON DELETE CASCADE);
      -- True only inside service.correct_visit_time: the flag is ignored for
      -- statements issued directly by a runtime role, so no application path
      -- can skip the audited correction or the evidence gates with it.
      CREATE FUNCTION service.visit_time_correction_active() RETURNS boolean
      LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
        SELECT coalesce(current_setting('service.visit_time_correction',true),'')='on'
          AND current_user NOT IN ('platform_web','platform_worker','platform_messaging','platform_voice','platform_readonly')
      $$;
      CREATE INDEX ix_visit_time_corrections_visit ON service.visit_time_corrections(tenant_id,visit_id,corrected_at);
      ALTER TABLE service.visit_time_corrections ENABLE ROW LEVEL SECURITY;
      ALTER TABLE service.visit_time_corrections FORCE ROW LEVEL SECURITY;
      CREATE POLICY visit_time_corrections_tenant_isolation ON service.visit_time_corrections
        USING (tenant_id=platform.current_tenant_id()) WITH CHECK (tenant_id=platform.current_tenant_id());
      CREATE POLICY visit_time_corrections_scope ON service.visit_time_corrections AS RESTRICTIVE
        USING (service.current_actor_can_work_visit(visit_id)) WITH CHECK (service.current_actor_can_work_visit(visit_id));

      -- Corrections of signed or explicit events happen only through the
      -- audited function below, which records the previous value.
      CREATE OR REPLACE FUNCTION service.prevent_signed_visit_mutation() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        IF service.visit_time_correction_active() THEN RETURN NEW; END IF;
        IF OLD.arrival_signature_object_id IS NOT NULL AND (
          NEW.arrival_signature_object_id IS DISTINCT FROM OLD.arrival_signature_object_id
          OR NEW.arrival_at IS DISTINCT FROM OLD.arrival_at
          OR NEW.arrival_identity IS DISTINCT FROM OLD.arrival_identity) THEN
          RAISE EXCEPTION 'signed arrival attendance is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.departure_signature_object_id IS NOT NULL AND (
          NEW.departure_signature_object_id IS DISTINCT FROM OLD.departure_signature_object_id
          OR NEW.departure_at IS DISTINCT FROM OLD.departure_at
          OR NEW.departure_identity IS DISTINCT FROM OLD.departure_identity) THEN
          RAISE EXCEPTION 'signed departure attendance is immutable' USING ERRCODE = '55000';
        END IF;
        IF (OLD.en_route_at IS NOT NULL AND NEW.en_route_at IS DISTINCT FROM OLD.en_route_at)
          OR (OLD.work_started_at IS NOT NULL AND NEW.work_started_at IS DISTINCT FROM OLD.work_started_at)
          OR (OLD.work_completed_at IS NOT NULL AND NEW.work_completed_at IS DISTINCT FROM OLD.work_completed_at) THEN
          RAISE EXCEPTION 'recorded visit times change only through an audited correction' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END $$;

      CREATE FUNCTION service.valid_evidence_photo_exists(p_tenant uuid,p_case uuid,p_visit uuid,p_category text) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT EXISTS(SELECT 1 FROM service.report_attachments attachment
          JOIN objects.object_metadata object ON object.tenant_id=attachment.tenant_id AND object.id=attachment.object_id
          WHERE attachment.tenant_id=p_tenant AND attachment.case_id=p_case AND attachment.category=p_category
            AND (p_visit IS NULL OR attachment.visit_id=p_visit)
            AND attachment.processing_status='available' AND object.status='available' AND object.deleted_at IS NULL
            AND object.content_type IN ('image/jpeg','image/png','image/webp'))
      $$;

      -- Explicit technician events. The server clock is the event time.
      CREATE FUNCTION service.record_visit_event(p_visit uuid,p_event text,p_request_id text) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_visit service.visits%ROWTYPE; v_technician uuid; v_policy jsonb;
        v_case service.cases%ROWTYPE; v_now timestamptz:=clock_timestamp(); v_changed boolean:=false; v_hash text;
      BEGIN
        IF p_event NOT IN ('en_route','work_started','work_completed') THEN RAISE EXCEPTION 'unsupported visit event' USING ERRCODE='22023'; END IF;
        IF NOT service.field_service_enabled() OR NOT platform.current_tenant_active() THEN RAISE EXCEPTION 'field service disabled' USING ERRCODE='42501'; END IF;
        PERFORM 1 FROM service.lock_current_technician_session_context();
        IF NOT FOUND THEN RAISE EXCEPTION 'active authenticated session required' USING ERRCODE='42501'; END IF;
        v_technician:=service.current_session_technician_id();
        SELECT * INTO v_visit FROM service.visits WHERE tenant_id=v_tenant AND id=p_visit FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'visit not found' USING ERRCODE='P0002'; END IF;
        IF v_technician IS NULL OR v_visit.technician_id<>v_technician THEN
          RAISE EXCEPTION 'only the assigned technician can record this visit event' USING ERRCODE='42501'; END IF;
        IF v_visit.status IN ('cancelled','reported') THEN RAISE EXCEPTION 'the visit is closed' USING ERRCODE='23514'; END IF;
        SELECT * INTO v_case FROM service.cases WHERE tenant_id=v_tenant AND id=v_visit.case_id FOR UPDATE;
        v_policy:=coalesce(v_case.workflow_policy,'{}'::jsonb);
        IF p_event='en_route' THEN
          IF v_visit.en_route_at IS NULL THEN
            IF coalesce((service.current_workflow_policy()#>>'{preparation,enabled}')::boolean,false)
              AND coalesce((service.current_workflow_policy()#>>'{preparation,requireAcknowledgement}')::boolean,false) THEN
              v_hash:=service.visit_preparation_hash(v_tenant,p_visit);
              IF NOT EXISTS(SELECT 1 FROM service.visit_preparations WHERE tenant_id=v_tenant AND visit_id=p_visit AND requirements_hash=v_hash) THEN
                RAISE EXCEPTION 'PREPARATION_ACKNOWLEDGEMENT_REQUIRED' USING ERRCODE='23514'; END IF;
            END IF;
            UPDATE service.visits SET en_route_at=v_now,updated_at=v_now WHERE tenant_id=v_tenant AND id=p_visit; v_changed:=true;
          END IF;
        ELSIF p_event='work_started' THEN
          IF v_visit.arrival_at IS NULL THEN RAISE EXCEPTION 'ARRIVAL_REQUIRED' USING ERRCODE='23514'; END IF;
          IF v_visit.work_started_at IS NULL THEN
            IF coalesce((v_policy#>>'{evidence,beforePhotoRequired}')::boolean,false)
              AND NOT service.valid_evidence_photo_exists(v_tenant,v_visit.case_id,p_visit,'before_photo') THEN
              RAISE EXCEPTION 'BEFORE_PHOTO_REQUIRED' USING ERRCODE='23514'; END IF;
            UPDATE service.visits SET work_started_at=v_now,updated_at=v_now WHERE tenant_id=v_tenant AND id=p_visit; v_changed:=true;
            IF v_case.status IN ('awaiting_scheduling','scheduled') THEN
              UPDATE service.cases SET status='in_progress',updated_at=v_now WHERE tenant_id=v_tenant AND id=v_case.id;
              INSERT INTO service.case_status_history(tenant_id,case_id,from_status,to_status,reason,actor_user_id)
                VALUES(v_tenant,v_case.id,v_case.status,'in_progress','Technician started work',platform.current_user_id());
            END IF;
          END IF;
        ELSE
          IF v_visit.work_started_at IS NULL AND v_visit.work_completed_at IS NULL THEN RAISE EXCEPTION 'WORK_START_REQUIRED' USING ERRCODE='23514'; END IF;
          IF v_visit.work_completed_at IS NULL THEN
            IF coalesce((v_policy#>>'{evidence,afterPhotoRequired}')::boolean,false)
              AND NOT service.valid_evidence_photo_exists(v_tenant,v_visit.case_id,p_visit,'after_photo') THEN
              RAISE EXCEPTION 'AFTER_PHOTO_REQUIRED' USING ERRCODE='23514'; END IF;
            UPDATE service.visits SET work_completed_at=v_now,updated_at=v_now WHERE tenant_id=v_tenant AND id=p_visit; v_changed:=true;
          END IF;
        END IF;
        IF v_changed THEN
          INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata)
            VALUES(v_tenant,platform.current_user_id(),'field_service.visit.'||p_event,'service_visit',p_visit,left(coalesce(p_request_id,gen_random_uuid()::text),200),
              jsonb_build_object('caseId',v_visit.case_id,'technicianId',v_technician,'recordedAt',v_now));
        END IF;
        RETURN (SELECT jsonb_build_object('visitId',id,'enRouteAt',en_route_at,'arrivalAt',arrival_at,'workStartedAt',work_started_at,
          'workCompletedAt',work_completed_at,'departureAt',departure_at,'changed',v_changed) FROM service.visits WHERE tenant_id=v_tenant AND id=p_visit);
      END $$;

      CREATE FUNCTION service.correct_visit_time(p_visit uuid,p_field text,p_value timestamptz,p_reason text) RETURNS uuid
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_role text:=coalesce(current_setting('app.current_role',true),'');
        v_previous timestamptz; v_id uuid; v_visit service.visits%ROWTYPE;
      BEGIN
        IF v_role NOT IN ('owner','admin') OR platform.current_user_id() IS NULL THEN
          RAISE EXCEPTION 'only an owner or administrator can correct visit times' USING ERRCODE='42501'; END IF;
        IF NOT service.field_service_enabled() THEN RAISE EXCEPTION 'field service disabled' USING ERRCODE='42501'; END IF;
        IF p_field NOT IN ('en_route_at','arrival_at','work_started_at','work_completed_at','departure_at') OR p_value IS NULL THEN
          RAISE EXCEPTION 'unsupported visit time correction' USING ERRCODE='22023'; END IF;
        IF char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'a correction reason is required' USING ERRCODE='22023'; END IF;
        IF p_value > clock_timestamp() + interval '5 minutes' THEN RAISE EXCEPTION 'a correction cannot be in the future' USING ERRCODE='22023'; END IF;
        SELECT * INTO v_visit FROM service.visits WHERE tenant_id=v_tenant AND id=p_visit FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'visit not found' USING ERRCODE='P0002'; END IF;
        EXECUTE format('SELECT %I FROM service.visits WHERE tenant_id=$1 AND id=$2',p_field) INTO v_previous USING v_tenant,p_visit;
        IF p_field IN ('arrival_at','departure_at') AND v_previous IS NULL THEN
          RAISE EXCEPTION 'signed attendance must be recorded by the technician before it can be corrected' USING ERRCODE='23514'; END IF;
        PERFORM set_config('service.visit_time_correction','on',true);
        EXECUTE format('UPDATE service.visits SET %I=$1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND id=$3',p_field) USING p_value,v_tenant,p_visit;
        PERFORM set_config('service.visit_time_correction','off',true);
        INSERT INTO service.visit_time_corrections(tenant_id,visit_id,field,previous_value,new_value,reason,corrected_by_user_id)
          VALUES(v_tenant,p_visit,p_field,v_previous,p_value,btrim(p_reason),platform.current_user_id()) RETURNING id INTO v_id;
        INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
          VALUES(v_tenant,platform.current_user_id(),'field_service.visit.time_corrected','service_visit',p_visit,
            jsonb_build_object('field',p_field,'previousValue',v_previous,'newValue',p_value,'correctionId',v_id));
        RETURN v_id;
      END $$;
    """)


def _preparation() -> None:
    _execute("""
      CREATE TABLE service.visit_preparations (
        tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
        visit_id uuid NOT NULL,
        requirements_hash text NOT NULL CHECK (requirements_hash ~ '^[0-9a-f]{32}$'),
        technician_id uuid NOT NULL,
        checked_items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checked_items)='array'),
        acknowledged_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
        acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (tenant_id,visit_id,requirements_hash),
        FOREIGN KEY (tenant_id,visit_id) REFERENCES service.visits(tenant_id,id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id,technician_id) REFERENCES service.technicians(tenant_id,id) ON DELETE RESTRICT);
      ALTER TABLE service.visit_preparations ENABLE ROW LEVEL SECURITY;
      ALTER TABLE service.visit_preparations FORCE ROW LEVEL SECURITY;
      CREATE POLICY visit_preparations_tenant_isolation ON service.visit_preparations
        USING (tenant_id=platform.current_tenant_id()) WITH CHECK (tenant_id=platform.current_tenant_id());
      CREATE POLICY visit_preparations_scope ON service.visit_preparations AS RESTRICTIVE
        USING (service.current_actor_can_work_visit(visit_id)) WITH CHECK (service.current_actor_can_work_visit(visit_id));

      -- Requirements come from the tenant's current preparation settings and
      -- the case's own data. Any change to either, or a reassignment, yields a
      -- new hash and therefore a new acknowledgement.
      CREATE FUNCTION service.visit_preparation_hash(p_tenant uuid,p_visit uuid) RETURNS text
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT md5(jsonb_build_object('preparation',service.current_workflow_policy()->'preparation','technician',visit.technician_id,
          'case',service_case.id,'title',service_case.title,'fault',service_case.fault_description,'productType',service_case.product_type,
          'productModel',service_case.product_model,'location',service_case.service_location_id)::text)
        FROM service.visits visit JOIN service.cases service_case ON service_case.tenant_id=visit.tenant_id AND service_case.id=visit.case_id
        WHERE visit.tenant_id=p_tenant AND visit.id=p_visit
      $$;

      CREATE FUNCTION service.visit_preparation(p_visit uuid) RETURNS jsonb
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_policy jsonb:=service.current_workflow_policy()->'preparation';
        v_hash text; v_ack service.visit_preparations%ROWTYPE; v_summary jsonb;
      BEGIN
        IF NOT service.field_service_enabled() OR NOT service.current_actor_can_work_visit(p_visit) THEN
          RAISE EXCEPTION 'visit access denied' USING ERRCODE='42501'; END IF;
        IF v_policy IS NULL OR coalesce((v_policy->>'enabled')::boolean,false) IS NOT TRUE THEN
          RETURN jsonb_build_object('enabled',false); END IF;
        SELECT jsonb_build_object('caseId',c.id,'reference',c.reference,'title',c.title,'faultDescription',left(c.fault_description,2000),
            'priority',c.priority,'productType',c.product_type,'productModel',c.product_model,'serialNumber',c.serial_number,
            'locationName',l.name,'locationAddress',l.address,'chainName',ch.name,'scheduledStart',a.starts_at,'scheduledEnd',a.ends_at,'scheduleTimezone',a.timezone)
          INTO v_summary
          FROM service.visits v JOIN service.cases c ON c.tenant_id=v.tenant_id AND c.id=v.case_id
          LEFT JOIN crm.service_locations l ON l.tenant_id=c.tenant_id AND l.id=c.service_location_id
          LEFT JOIN crm.service_chains ch ON ch.tenant_id=l.tenant_id AND ch.id=l.chain_id
          LEFT JOIN service.appointments a ON a.tenant_id=v.tenant_id AND a.id=v.appointment_id
          WHERE v.tenant_id=v_tenant AND v.id=p_visit;
        IF v_summary IS NULL THEN RAISE EXCEPTION 'visit not found' USING ERRCODE='P0002'; END IF;
        v_hash:=service.visit_preparation_hash(v_tenant,p_visit);
        SELECT * INTO v_ack FROM service.visit_preparations WHERE tenant_id=v_tenant AND visit_id=p_visit AND requirements_hash=v_hash;
        RETURN jsonb_build_object('enabled',true,'requirementsHash',v_hash,'summary',v_summary,
          'checklist',coalesce(v_policy->'checklist','[]'::jsonb),'instructions',v_policy->>'instructions',
          'requireAcknowledgement',coalesce((v_policy->>'requireAcknowledgement')::boolean,false),
          'acknowledged',v_ack.visit_id IS NOT NULL,'acknowledgedAt',v_ack.acknowledged_at,'checkedItems',coalesce(v_ack.checked_items,'[]'::jsonb));
      END $$;

      CREATE FUNCTION service.acknowledge_visit_preparation(p_visit uuid,p_hash text,p_checked jsonb) RETURNS jsonb
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_policy jsonb:=service.current_workflow_policy()->'preparation';
        v_technician uuid; v_visit service.visits%ROWTYPE;
      BEGIN
        IF NOT service.field_service_enabled() THEN RAISE EXCEPTION 'field service disabled' USING ERRCODE='42501'; END IF;
        IF v_policy IS NULL OR coalesce((v_policy->>'enabled')::boolean,false) IS NOT TRUE THEN
          RAISE EXCEPTION 'preparation is not enabled' USING ERRCODE='22023'; END IF;
        PERFORM 1 FROM service.lock_current_technician_session_context();
        IF NOT FOUND THEN RAISE EXCEPTION 'active authenticated session required' USING ERRCODE='42501'; END IF;
        v_technician:=service.current_session_technician_id();
        SELECT * INTO v_visit FROM service.visits WHERE tenant_id=v_tenant AND id=p_visit FOR UPDATE;
        IF NOT FOUND OR v_technician IS NULL OR v_visit.technician_id<>v_technician THEN
          RAISE EXCEPTION 'only the assigned technician can acknowledge preparation' USING ERRCODE='42501'; END IF;
        IF p_hash IS DISTINCT FROM service.visit_preparation_hash(v_tenant,p_visit) THEN
          RAISE EXCEPTION 'PREPARATION_REQUIREMENTS_CHANGED' USING ERRCODE='40001'; END IF;
        IF jsonb_typeof(coalesce(p_checked,'[]'::jsonb))<>'array' OR jsonb_array_length(coalesce(p_checked,'[]'::jsonb))>30
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_checked,'[]'::jsonb)) item WHERE jsonb_typeof(item)<>'string'
            OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_policy->'checklist') required WHERE required->>'key'=item#>>'{}')) THEN
          RAISE EXCEPTION 'unknown checklist item' USING ERRCODE='22023'; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_policy->'checklist') required WHERE (required->>'required')::boolean
            AND NOT coalesce(p_checked,'[]'::jsonb) ? (required->>'key')) THEN
          RAISE EXCEPTION 'PREPARATION_CHECKLIST_INCOMPLETE' USING ERRCODE='23514'; END IF;
        INSERT INTO service.visit_preparations(tenant_id,visit_id,requirements_hash,technician_id,checked_items,acknowledged_by_user_id)
          VALUES(v_tenant,p_visit,p_hash,v_technician,coalesce(p_checked,'[]'::jsonb),platform.current_user_id())
          ON CONFLICT (tenant_id,visit_id,requirements_hash) DO NOTHING;
        INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
          VALUES(v_tenant,platform.current_user_id(),'field_service.visit.preparation_acknowledged','service_visit',p_visit,
            jsonb_build_object('requirementsHash',p_hash,'technicianId',v_technician,'checkedItems',coalesce(p_checked,'[]'::jsonb)));
        RETURN service.visit_preparation(p_visit);
      END $$;
    """)


def _attachments_and_evidence() -> None:
    _execute(f"""
      ALTER TABLE service.report_attachments DROP CONSTRAINT ck_report_attachment_category;
      ALTER TABLE service.report_attachments
        ADD COLUMN document_type text,
        ADD CONSTRAINT ck_report_attachment_category CHECK (category IN ({BUILT_IN_CATEGORIES})),
        ADD CONSTRAINT ck_report_attachment_document_type CHECK (
          (category='tenant_document') = (document_type IS NOT NULL)
          AND (document_type IS NULL OR document_type ~ '^[a-z][a-z0-9_]{{1,31}}$'));

      CREATE OR REPLACE FUNCTION service.validate_report_attachment_context() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      DECLARE v_owner_type text; v_owner_id uuid; v_content_type text; v_accept jsonb;
      BEGIN
        IF NEW.visit_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM service.visits visit WHERE visit.tenant_id=NEW.tenant_id AND visit.id=NEW.visit_id AND visit.case_id=NEW.case_id) THEN
          RAISE EXCEPTION 'attachment visit does not belong to the case' USING ERRCODE = '23514';
        END IF;
        IF NEW.report_revision_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM service.report_revisions revision
          JOIN service.reports report ON report.tenant_id=revision.tenant_id AND report.id=revision.report_id
          WHERE revision.tenant_id=NEW.tenant_id AND revision.id=NEW.report_revision_id AND report.case_id=NEW.case_id
            AND (NEW.visit_id IS NULL OR report.visit_id=NEW.visit_id) AND revision.status IN ('draft','review_required')) THEN
          RAISE EXCEPTION 'attachment report revision is not editable or does not match the case visit' USING ERRCODE = '23514';
        END IF;
        IF NEW.category IN ('arrival_signature','departure_signature') AND (NEW.visit_id IS NULL OR NEW.source <> 'technician') THEN
          RAISE EXCEPTION 'attendance signatures require a technician visit' USING ERRCODE = '23514';
        END IF;
        -- Technician evidence belongs to a visit and is taken by a technician,
        -- a customer's intake photo can never be relabelled as it.
        IF NEW.category IN ('before_photo','after_photo') AND (NEW.visit_id IS NULL OR NEW.source <> 'technician' OR NEW.message_id IS NOT NULL) THEN
          RAISE EXCEPTION 'before and after photos must be technician uploads on a visit' USING ERRCODE = '23514';
        END IF;
        SELECT owner_type, owner_id, content_type INTO v_owner_type, v_owner_id, v_content_type
        FROM objects.object_metadata object WHERE object.tenant_id=NEW.tenant_id AND object.id=NEW.object_id AND object.deleted_at IS NULL;
        IF v_owner_type = 'service_case' AND v_owner_id <> NEW.case_id THEN
          RAISE EXCEPTION 'attachment object does not belong to the case' USING ERRCODE = '23514';
        END IF;
        IF v_owner_type = 'message' AND (NEW.message_id IS NULL OR v_owner_id <> NEW.message_id) THEN
          RAISE EXCEPTION 'message attachment object does not match its source message' USING ERRCODE = '23514';
        END IF;
        IF v_owner_type NOT IN ('service_case','message') THEN
          RAISE EXCEPTION 'unsupported service attachment owner' USING ERRCODE = '23514';
        END IF;
        IF NEW.category IN ('fault','module','product_label','repair','environment','customer_photo','arrival_signature','departure_signature','before_photo','after_photo')
          AND v_content_type NOT IN ('image/jpeg','image/png','image/webp') THEN
          RAISE EXCEPTION 'this evidence category requires an image' USING ERRCODE = '23514';
        END IF;
        IF NEW.category='tenant_document' AND TG_OP='INSERT' THEN
          SELECT item->'accept' INTO v_accept FROM jsonb_array_elements(coalesce(service.current_workflow_policy()->'attachmentCategories','[]'::jsonb)) item
            WHERE item->>'key'=NEW.document_type;
          IF v_accept IS NULL THEN RAISE EXCEPTION 'this document type is not configured' USING ERRCODE = '23514'; END IF;
          IF NOT ((v_accept ? 'image' AND v_content_type IN ('image/jpeg','image/png','image/webp'))
            OR (v_accept ? 'pdf' AND v_content_type='application/pdf')) THEN
            RAISE EXCEPTION 'this document type does not accept the uploaded file type' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$;

      -- Evidence gates on every server path that changes the stage: API,
      -- alternate screens, bulk updates, AI tools and SQL functions alike.
      -- Gates read the case's pinned policy, so cases opened before a tenant
      -- enabled evidence keep the rules they were opened under.
      CREATE FUNCTION service.enforce_case_evidence() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_policy jsonb:=coalesce(NEW.workflow_policy,'{{}}'::jsonb);
      BEGIN
        IF NEW.status='in_progress' AND OLD.status IS DISTINCT FROM 'in_progress'
          AND coalesce((v_policy#>>'{{evidence,beforePhotoRequired}}')::boolean,false)
          AND NOT service.valid_evidence_photo_exists(NEW.tenant_id,NEW.id,NULL,'before_photo') THEN
          RAISE EXCEPTION 'BEFORE_PHOTO_REQUIRED' USING ERRCODE='23514';
        END IF;
        IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed'
          AND coalesce((v_policy#>>'{{evidence,afterPhotoRequired}}')::boolean,false)
          AND NOT service.valid_evidence_photo_exists(NEW.tenant_id,NEW.id,NULL,'after_photo') THEN
          RAISE EXCEPTION 'AFTER_PHOTO_REQUIRED' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_service_case_evidence BEFORE UPDATE OF status ON service.cases
        FOR EACH ROW EXECUTE FUNCTION service.enforce_case_evidence();

      CREATE FUNCTION service.enforce_visit_evidence() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      DECLARE v_policy jsonb:=service.case_workflow_policy(NEW.tenant_id,NEW.case_id);
      BEGIN
        IF service.visit_time_correction_active() THEN RETURN NEW; END IF;
        IF NEW.work_started_at IS NOT NULL AND OLD.work_started_at IS NULL
          AND coalesce((v_policy#>>'{{evidence,beforePhotoRequired}}')::boolean,false)
          AND NOT service.valid_evidence_photo_exists(NEW.tenant_id,NEW.case_id,NEW.id,'before_photo') THEN
          RAISE EXCEPTION 'BEFORE_PHOTO_REQUIRED' USING ERRCODE='23514';
        END IF;
        IF NEW.work_completed_at IS NOT NULL AND OLD.work_completed_at IS NULL
          AND coalesce((v_policy#>>'{{evidence,afterPhotoRequired}}')::boolean,false)
          AND NOT service.valid_evidence_photo_exists(NEW.tenant_id,NEW.case_id,NEW.id,'after_photo') THEN
          RAISE EXCEPTION 'AFTER_PHOTO_REQUIRED' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_service_visit_evidence BEFORE UPDATE OF work_started_at,work_completed_at ON service.visits
        FOR EACH ROW EXECUTE FUNCTION service.enforce_visit_evidence();

      CREATE FUNCTION service.enforce_report_evidence() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_case uuid; v_visit uuid;
      BEGIN
        IF NEW.status='finalized' AND OLD.status IS DISTINCT FROM 'finalized' THEN
          SELECT report.case_id,report.visit_id INTO v_case,v_visit FROM service.reports report
            WHERE report.tenant_id=NEW.tenant_id AND report.id=NEW.report_id;
          IF coalesce((service.case_workflow_policy(NEW.tenant_id,v_case)#>>'{{evidence,afterPhotoRequired}}')::boolean,false)
            AND NOT service.valid_evidence_photo_exists(NEW.tenant_id,v_case,v_visit,'after_photo') THEN
            RAISE EXCEPTION 'AFTER_PHOTO_REQUIRED' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_service_report_evidence BEFORE UPDATE OF status ON service.report_revisions
        FOR EACH ROW EXECUTE FUNCTION service.enforce_report_evidence();
      CREATE TRIGGER trg_service_report_evidence_insert BEFORE INSERT ON service.report_revisions
        FOR EACH ROW WHEN (NEW.status='finalized') EXECUTE FUNCTION service.enforce_report_evidence();
    """)


def _grants() -> None:
    for signature in (
        "service.redact_workflow_policy(jsonb)",
        "service.case_workflow_policy(uuid,uuid)",
        "support.mark_ticket_emergency(uuid,text,text)",
        "support.record_ticket_escalation(uuid,text,text)",
        "service.valid_evidence_photo_exists(uuid,uuid,uuid,text)",
        "service.record_visit_event(uuid,text,text)",
        "service.correct_visit_time(uuid,text,timestamptz,text)",
        "service.visit_preparation_hash(uuid,uuid)",
        "service.visit_preparation(uuid)",
        "service.acknowledge_visit_preparation(uuid,text,jsonb)",
        "service.enforce_case_evidence()",
        "service.enforce_visit_evidence()",
        "service.enforce_report_evidence()",
    ):
        _execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
    # Invoked by triggers under the statement's role; they only read.
    _execute(
        "GRANT EXECUTE ON FUNCTION service.case_workflow_policy(uuid,uuid),"
        "service.valid_evidence_photo_exists(uuid,uuid,uuid,text) TO platform_web,platform_worker,platform_messaging,platform_voice"
    )
    _execute(
        "GRANT EXECUTE ON FUNCTION support.mark_ticket_emergency(uuid,text,text),"
        "service.record_visit_event(uuid,text,text),service.correct_visit_time(uuid,text,timestamptz,text),"
        "service.visit_preparation(uuid),service.acknowledge_visit_preparation(uuid,text,jsonb) TO platform_web"
    )
    _execute(
        "GRANT EXECUTE ON FUNCTION support.mark_ticket_emergency(uuid,text,text),"
        "support.record_ticket_escalation(uuid,text,text) TO platform_voice"
    )
    _execute("GRANT SELECT ON service.visit_time_corrections,service.visit_preparations TO platform_web")
    _execute(
        "GRANT SELECT ON service.visit_time_corrections,service.visit_preparations TO platform_readonly"
    )


def downgrade() -> None:
    _execute("DROP TRIGGER IF EXISTS trg_service_report_evidence_insert ON service.report_revisions")
    _execute("DROP TRIGGER IF EXISTS trg_service_report_evidence ON service.report_revisions")
    _execute("DROP TRIGGER IF EXISTS trg_service_visit_evidence ON service.visits")
    _execute("DROP TRIGGER IF EXISTS trg_service_case_evidence ON service.cases")
    for signature in (
        "service.enforce_report_evidence()",
        "service.enforce_visit_evidence()",
        "service.enforce_case_evidence()",
        "service.acknowledge_visit_preparation(uuid,text,jsonb)",
        "service.visit_preparation(uuid)",
        "service.correct_visit_time(uuid,text,timestamptz,text)",
        "service.record_visit_event(uuid,text,text)",
        "service.visit_preparation_hash(uuid,uuid)",
        "service.valid_evidence_photo_exists(uuid,uuid,uuid,text)",
        "support.record_ticket_escalation(uuid,text,text)",
        "support.mark_ticket_emergency(uuid,text,text)",
        "service.case_workflow_policy(uuid,uuid)",
    ):
        _execute(f"DROP FUNCTION IF EXISTS {signature}")
    _execute("DROP TABLE service.visit_preparations")
    _execute("DROP TABLE service.visit_time_corrections")
    # Rows using the new categories are removed from the attachment table's
    # contract; a rollback keeps their objects but not their evidence links.
    _execute(
        "DELETE FROM service.report_attachments WHERE category IN ('before_photo','after_photo','tenant_document')"
    )
    _execute(
        "ALTER TABLE service.report_attachments DROP CONSTRAINT ck_report_attachment_document_type,"
        " DROP CONSTRAINT ck_report_attachment_category, DROP COLUMN document_type"
    )
    _execute(
        "ALTER TABLE service.report_attachments ADD CONSTRAINT ck_report_attachment_category CHECK (category IN "
        "('fault','module','product_label','repair','environment','document','customer_photo','arrival_signature','departure_signature'))"
    )
    _execute(
        "ALTER TABLE service.visits DROP CONSTRAINT ck_visit_work_order, DROP COLUMN en_route_at,"
        " DROP COLUMN work_started_at, DROP COLUMN work_completed_at"
    )
    _execute("DROP INDEX IF EXISTS support.ix_support_tickets_emergency")
    _execute(
        "ALTER TABLE support.tickets DROP CONSTRAINT ck_support_ticket_emergency_shape,"
        " DROP COLUMN emergency_marked_by_user_id, DROP COLUMN emergency_source,"
        " DROP COLUMN emergency_reason, DROP COLUMN emergency_at"
    )
    _execute("DROP FUNCTION IF EXISTS service.visit_time_correction_active()")
    # Function bodies revert to the previous revision's definitions.
    _restore_previous_functions()


def _restore_previous_functions() -> None:
    _execute("""
      CREATE OR REPLACE FUNCTION service.validate_workflow_policy(p_policy jsonb) RETURNS boolean
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
      CREATE OR REPLACE FUNCTION service.prevent_signed_visit_mutation() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        IF OLD.arrival_signature_object_id IS NOT NULL AND (
          NEW.arrival_signature_object_id IS DISTINCT FROM OLD.arrival_signature_object_id
          OR NEW.arrival_at IS DISTINCT FROM OLD.arrival_at
          OR NEW.arrival_identity IS DISTINCT FROM OLD.arrival_identity) THEN
          RAISE EXCEPTION 'signed arrival attendance is immutable' USING ERRCODE = '55000';
        END IF;
        IF OLD.departure_signature_object_id IS NOT NULL AND (
          NEW.departure_signature_object_id IS DISTINCT FROM OLD.departure_signature_object_id
          OR NEW.departure_at IS DISTINCT FROM OLD.departure_at
          OR NEW.departure_identity IS DISTINCT FROM OLD.departure_identity) THEN
          RAISE EXCEPTION 'signed departure attendance is immutable' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION service.validate_report_attachment_context() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      DECLARE v_owner_type text; v_owner_id uuid; v_content_type text;
      BEGIN
        IF NEW.visit_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM service.visits visit WHERE visit.tenant_id=NEW.tenant_id AND visit.id=NEW.visit_id AND visit.case_id=NEW.case_id) THEN
          RAISE EXCEPTION 'attachment visit does not belong to the case' USING ERRCODE = '23514';
        END IF;
        IF NEW.report_revision_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM service.report_revisions revision
          JOIN service.reports report ON report.tenant_id=revision.tenant_id AND report.id=revision.report_id
          WHERE revision.tenant_id=NEW.tenant_id AND revision.id=NEW.report_revision_id AND report.case_id=NEW.case_id
            AND (NEW.visit_id IS NULL OR report.visit_id=NEW.visit_id) AND revision.status IN ('draft','review_required')) THEN
          RAISE EXCEPTION 'attachment report revision is not editable or does not match the case visit' USING ERRCODE = '23514';
        END IF;
        IF NEW.category IN ('arrival_signature','departure_signature') AND (NEW.visit_id IS NULL OR NEW.source <> 'technician') THEN
          RAISE EXCEPTION 'attendance signatures require a technician visit' USING ERRCODE = '23514';
        END IF;
        SELECT owner_type, owner_id, content_type INTO v_owner_type, v_owner_id, v_content_type
        FROM objects.object_metadata object WHERE object.tenant_id=NEW.tenant_id AND object.id=NEW.object_id AND object.deleted_at IS NULL;
        IF v_owner_type = 'service_case' AND v_owner_id <> NEW.case_id THEN
          RAISE EXCEPTION 'attachment object does not belong to the case' USING ERRCODE = '23514';
        END IF;
        IF v_owner_type = 'message' AND (NEW.message_id IS NULL OR v_owner_id <> NEW.message_id) THEN
          RAISE EXCEPTION 'message attachment object does not match its source message' USING ERRCODE = '23514';
        END IF;
        IF v_owner_type NOT IN ('service_case','message') THEN
          RAISE EXCEPTION 'unsupported service attachment owner' USING ERRCODE = '23514';
        END IF;
        IF NEW.category IN ('fault','module','product_label','repair','environment','customer_photo','arrival_signature','departure_signature')
          AND v_content_type NOT IN ('image/jpeg','image/png','image/webp') THEN
          RAISE EXCEPTION 'this evidence category requires an image' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
    """)
    _execute(f"""
      DROP FUNCTION IF EXISTS service.redact_workflow_policy(jsonb) CASCADE;
      CREATE OR REPLACE FUNCTION service.current_workflow_policy() RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT coalesce((SELECT configuration->'workflow' FROM platform.tenant_feature_entitlements
          WHERE tenant_id=platform.current_tenant_id() AND feature_key='field_service'),'{LEGACY_POLICY}'::jsonb)
      $$;
      CREATE OR REPLACE FUNCTION service.pin_intake_workflow() RETURNS trigger
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
    """)
