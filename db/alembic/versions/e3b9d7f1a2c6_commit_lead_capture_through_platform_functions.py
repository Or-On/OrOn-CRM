"""Commit lead capture through one set of platform functions.

Voice runs in Python and WhatsApp in TypeScript. Both normalize a customer's
answer against ``db/contracts/lead-capture.v1.json`` in their own language, and
both then hand the normalized observation to the same ``platform.lead_*``
functions below. Those functions are the only lead write path: they resolve the
tenant, contact and interaction binding, check the pinned agent version's
capability, fence a superseded worker, claim the idempotent operation key,
check the revision, apply human-verified precedence, supersede the previous
value, and return the durable receipt an agent must hold before it may say
"saved". Runtime roles lose their direct INSERT/UPDATE grants so no caller can
route around them.

``crm.lead_interactions`` records every interaction that touched a lead, so a
lead started on WhatsApp and continued on a callback shows both, and the call's
continuation is found through the originating conversation rather than by
guessing a customer's "latest" lead from a phone number.

Revision ID: e3b9d7f1a2c6
Revises: c7a41d6e9b52
Create Date: 2026-09-19 17:20:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e3b9d7f1a2c6"
down_revision: str | None = "c7a41d6e9b52"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_RUNTIME_ROLES = ("platform_messaging", "platform_voice", "platform_worker")
_CALLER_ROLES = ("platform_web", *_RUNTIME_ROLES)

_PUBLIC_FUNCTIONS = (
    "platform.lead_ensure_for_interaction(jsonb,text,uuid,integer,text,text,uuid)",
    "platform.lead_save_fields(jsonb,uuid,text,integer,jsonb)",
    "platform.lead_finalize(jsonb,uuid,text,integer,text,text)",
    "platform.lead_request_follow_up(jsonb,uuid,text,text,timestamptz)",
    "platform.lead_capture_state(jsonb,uuid,text)",
    "platform.lead_operation_receipt(jsonb,text)",
)
# A person's correction is recorded only through this entry point, and only the
# operator workspace role may execute it.
_OPERATOR_FUNCTIONS = ("platform.lead_operator_save_fields(jsonb,uuid,text,integer,jsonb)",)
_INTERNAL_FUNCTIONS = (
    "platform.lead_bind(jsonb,text,boolean)",
    "platform.lead_save_fields_core(jsonb,uuid,text,integer,jsonb,boolean)",
    "platform.lead_claim_operation(text,text,uuid)",
    "platform.lead_lock(uuid,jsonb)",
    "platform.lead_receipt(crm.leads,text,text,text[])",
    "platform.lead_commit(text,crm.leads,jsonb,text,jsonb)",
    "platform.lead_interaction_candidate(jsonb,text)",
)

_BIND = """
CREATE FUNCTION platform.lead_bind(p_binding jsonb, p_capability text, p_operator boolean)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
DECLARE
  v_tenant uuid := platform.current_tenant_id();
  v_channel text := p_binding->>'sourceChannel';
  v_recorded_by text := p_binding->>'recordedBy';
  v_epoch text := p_binding->>'conversationOwnershipEpoch';
  v_contact uuid;
  v_actor uuid;
  v_agent uuid;
  v_conversation uuid;
  v_session uuid;
  v_handoff uuid;
  v_permissions jsonb;
  v_owner_contact uuid;
  v_mode text;
  v_current_epoch text;
  v_status text;
  v_ended timestamptz;
BEGIN
  IF v_tenant IS NULL OR NOT platform.current_tenant_active() THEN
    RAISE EXCEPTION 'tenant is not active' USING ERRCODE='LD403';
  END IF;
  IF jsonb_typeof(p_binding) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'lead binding must be an object' USING ERRCODE='LD422';
  END IF;
  IF p_capability NOT IN ('lead.read','lead.write','lead.finalize','lead.follow_up') THEN
    RAISE EXCEPTION 'unsupported lead capability' USING ERRCODE='LD422';
  END IF;
  BEGIN
    v_contact := (p_binding->>'contactId')::uuid;
    v_actor := (p_binding->>'actorUserId')::uuid;
    v_agent := (p_binding->>'agentProfileVersionId')::uuid;
    v_conversation := (p_binding->>'conversationId')::uuid;
    v_session := (p_binding->>'sessionId')::uuid;
    v_handoff := (p_binding->>'handoffId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'lead binding identifiers must be UUIDs' USING ERRCODE='LD422';
  END;
  IF v_contact IS NULL THEN
    RAISE EXCEPTION 'lead binding requires a contact' USING ERRCODE='LD422';
  END IF;
  IF v_channel IS NULL OR v_channel NOT IN ('voice','whatsapp','manual','api') THEN
    RAISE EXCEPTION 'unsupported lead source channel' USING ERRCODE='LD422';
  END IF;
  IF v_recorded_by IS NULL OR v_recorded_by NOT IN ('agent','human') THEN
    RAISE EXCEPTION 'unsupported lead writer' USING ERRCODE='LD422';
  END IF;
  PERFORM 1 FROM crm.contacts WHERE tenant_id=v_tenant AND id=v_contact;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact is unavailable' USING ERRCODE='LD404';
  END IF;

  IF v_recorded_by='human' THEN
    -- Only the operator entry point, which only the workspace role may execute,
    -- records a person's edit. A conversational runtime claiming
    -- recordedBy=human would otherwise outrank the customer's own words.
    IF NOT p_operator THEN
      RAISE EXCEPTION 'only the operator workspace may record a human edit'
        USING ERRCODE='LD403';
    END IF;
    IF v_actor IS NULL OR v_channel <> 'manual' THEN
      RAISE EXCEPTION 'a human edit names its operator and is manual' USING ERRCODE='LD422';
    END IF;
    IF NOT platform.messaging_ai_actor_authorized(v_actor) THEN
      RAISE EXCEPTION 'operator is not authorized for this tenant' USING ERRCODE='LD403';
    END IF;
  ELSE
    IF p_operator THEN
      RAISE EXCEPTION 'the operator entry point records human edits only'
        USING ERRCODE='LD422';
    END IF;
    IF v_channel NOT IN ('voice','whatsapp') THEN
      RAISE EXCEPTION 'agents write leads only from voice or WhatsApp' USING ERRCODE='LD422';
    END IF;
    IF v_agent IS NULL THEN
      RAISE EXCEPTION 'an agent write names its pinned agent version' USING ERRCODE='LD422';
    END IF;
    -- The pinned version is rechecked, never upgraded: a newer draft cannot
    -- change what a running interaction may do, but an unpublished or invalid
    -- version stops it.
    SELECT agent.tool_permissions INTO v_permissions
    FROM agents.agent_profile_versions agent
    WHERE agent.tenant_id=v_tenant AND agent.id=v_agent
      AND agent.published_at IS NOT NULL AND agent.validation_status='valid'
      AND v_channel = ANY(agent.channel_capabilities);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pinned agent version is not published for this channel'
        USING ERRCODE='LD403';
    END IF;
    IF NOT (
      v_permissions ? p_capability
      OR (p_capability='lead.read'
          AND v_permissions ?| ARRAY['lead.write','lead.finalize','lead.follow_up'])
    ) THEN
      RAISE EXCEPTION 'agent is not authorized for %', p_capability USING ERRCODE='LD403';
    END IF;
    IF v_actor IS NOT NULL AND NOT platform.messaging_ai_actor_authorized(v_actor) THEN
      RAISE EXCEPTION 'authorizing operator is no longer active' USING ERRCODE='LD403';
    END IF;
    IF v_channel='whatsapp' THEN
      IF v_conversation IS NULL THEN
        RAISE EXCEPTION 'a WhatsApp write names its conversation' USING ERRCODE='LD422';
      END IF;
      SELECT contact_id, ownership_mode, ownership_epoch::text
      INTO v_owner_contact, v_mode, v_current_epoch
      FROM messaging.conversations WHERE tenant_id=v_tenant AND id=v_conversation;
      IF NOT FOUND OR v_owner_contact IS DISTINCT FROM v_contact THEN
        RAISE EXCEPTION 'interaction conversation is unavailable' USING ERRCODE='LD404';
      END IF;
      IF v_epoch IS NOT NULL AND v_epoch <> v_current_epoch THEN
        RAISE EXCEPTION 'interaction ownership changed' USING ERRCODE='LD423';
      END IF;
      IF v_epoch IS NOT NULL AND v_mode <> 'ai' THEN
        RAISE EXCEPTION 'a person now owns this conversation' USING ERRCODE='LD423';
      END IF;
    ELSE
      IF v_session IS NULL THEN
        RAISE EXCEPTION 'a voice write names its call' USING ERRCODE='LD422';
      END IF;
      SELECT contact_id, status::text, ended_at INTO v_owner_contact, v_status, v_ended
      FROM public.sessions WHERE tenant_id=v_tenant AND session_id=v_session;
      IF NOT FOUND OR v_owner_contact IS DISTINCT FROM v_contact THEN
        RAISE EXCEPTION 'interaction call is unavailable' USING ERRCODE='LD404';
      END IF;
      -- A worker that outlived its call, or that a person has paused, is fenced
      -- here rather than trusted to notice on its own.
      IF v_ended IS NOT NULL OR v_status <> 'started' THEN
        RAISE EXCEPTION 'the call has ended' USING ERRCODE='LD423';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.voice_session_controls control
        WHERE control.tenant_id=v_tenant AND control.session_id=v_session
          AND control.desired_mode <> 'ai'
      ) THEN
        RAISE EXCEPTION 'a person now owns this call' USING ERRCODE='LD423';
      END IF;
      IF v_conversation IS NOT NULL THEN
        PERFORM 1 FROM messaging.conversations
        WHERE tenant_id=v_tenant AND id=v_conversation AND contact_id=v_contact;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'originating conversation is unavailable' USING ERRCODE='LD404';
        END IF;
        -- Only the conversation this call was admitted for, as the dispatcher
        -- recorded it — not any conversation the same contact happens to have.
        PERFORM 1 FROM public.session_events admission
        WHERE admission.tenant_id=v_tenant AND admission.session_id=v_session
          AND admission.event_type='voice.call.admission.v1'
          AND admission.payload->>'source_conversation_id'=v_conversation::text;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'originating conversation is not bound to this call'
            USING ERRCODE='LD404';
        END IF;
        -- A phone association is not a verified identity: a secured callback
        -- reaches that conversation's lead only after verification unlocks it.
        IF EXISTS (
          SELECT 1 FROM automation.voice_identity_verifications verification
          WHERE verification.tenant_id=v_tenant AND verification.session_id=v_session
            AND verification.state <> 'context_unlocked'
        ) THEN
          RAISE EXCEPTION 'caller identity is not verified for this conversation'
            USING ERRCODE='LD423';
        END IF;
      END IF;
    END IF;
  END IF;
  IF v_handoff IS NOT NULL THEN
    PERFORM 1 FROM automation.handoffs WHERE tenant_id=v_tenant AND id=v_handoff;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'handoff is unavailable' USING ERRCODE='LD404';
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'tenantId', v_tenant, 'contactId', v_contact, 'sourceChannel', v_channel,
    'recordedBy', v_recorded_by, 'actorUserId', v_actor,
    'actorService', CASE WHEN v_recorded_by='agent' THEN v_channel || '-agent' END,
    'agentProfileVersionId', v_agent, 'conversationId', v_conversation,
    'sessionId', v_session, 'handoffId', v_handoff
  );
END
$$
"""

_CLAIM = """
CREATE FUNCTION platform.lead_claim_operation(
  p_key text, p_operation text, p_lead uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
DECLARE
  v_tenant uuid := platform.current_tenant_id();
  v_key text := btrim(coalesce(p_key, ''));
  v_id uuid;
  v_existing crm.lead_operations%ROWTYPE;
BEGIN
  IF length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'operation key must contain 8-200 characters' USING ERRCODE='LD422';
  END IF;
  -- A concurrent attempt holding the same key is waited out by the unique
  -- index: after it commits we replay its receipt, after it aborts we own it.
  INSERT INTO crm.lead_operations (tenant_id, lead_id, operation_key, operation, status)
  VALUES (v_tenant, p_lead, v_key, p_operation, 'pending')
  ON CONFLICT (tenant_id, operation_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_existing FROM crm.lead_operations
  WHERE tenant_id=v_tenant AND operation_key=v_key FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO crm.lead_operations (tenant_id, lead_id, operation_key, operation, status)
    VALUES (v_tenant, p_lead, v_key, p_operation, 'pending');
    RETURN NULL;
  END IF;
  IF v_existing.operation <> p_operation THEN
    RAISE EXCEPTION 'operation key was already used for another action'
      USING ERRCODE='LD412';
  END IF;
  IF v_existing.status='committed' THEN
    RETURN v_existing.receipt || jsonb_build_object('status', 'replayed');
  END IF;
  UPDATE crm.lead_operations SET status='pending', error_safe=NULL
  WHERE tenant_id=v_tenant AND operation_key=v_key;
  RETURN NULL;
END
$$
"""

_LOCK = """
CREATE FUNCTION platform.lead_lock(p_lead uuid, p_bound jsonb)
RETURNS crm.leads
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
DECLARE
  v_lead crm.leads%ROWTYPE;
BEGIN
  SELECT * INTO v_lead FROM crm.leads
  WHERE tenant_id=(p_bound->>'tenantId')::uuid AND id=p_lead AND archived_at IS NULL
  FOR UPDATE;
  -- The interaction's own contact is authoritative. Another person's lead is
  -- invisible to this conversation even inside the same tenant.
  IF NOT FOUND OR v_lead.contact_id <> (p_bound->>'contactId')::uuid THEN
    RAISE EXCEPTION 'lead is not available for this tenant and interaction'
      USING ERRCODE='LD404';
  END IF;
  RETURN v_lead;
END
$$
"""

_RECEIPT = """
CREATE FUNCTION platform.lead_receipt(
  p_lead crm.leads, p_operation text, p_key text, p_changed text[]
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
  SELECT jsonb_build_object(
    'leadId', p_lead.id, 'reference', p_lead.reference, 'operation', p_operation,
    'operationKey', btrim(p_key), 'revision', p_lead.revision, 'status', 'committed',
    'changed', to_jsonb(coalesce(p_changed, ARRAY[]::text[])),
    'committedAt', to_char(clock_timestamp() AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
$$
"""

# Every successful mutation ends here: the receipt is stored against the
# operation key, the interaction is linked and the change is audited, all in
# the caller's transaction, so a receipt exists exactly when the write does.
_COMMIT = """
CREATE FUNCTION platform.lead_commit(
  p_key text, p_lead crm.leads, p_receipt jsonb, p_action text, p_metadata jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
DECLARE
  v_bound jsonb := p_metadata->'binding';
BEGIN
  UPDATE crm.lead_operations
  SET status='committed', lead_id=p_lead.id, receipt=p_receipt,
      completed_at=clock_timestamp()
  WHERE tenant_id=p_lead.tenant_id AND operation_key=btrim(p_key);
  IF (v_bound->>'sourceChannel') IN ('voice','whatsapp') THEN
    INSERT INTO crm.lead_interactions AS link
      (tenant_id, lead_id, channel, conversation_id, session_id, handoff_id,
       agent_profile_version_id)
    VALUES (p_lead.tenant_id, p_lead.id, v_bound->>'sourceChannel',
            (v_bound->>'conversationId')::uuid, (v_bound->>'sessionId')::uuid,
            (v_bound->>'handoffId')::uuid, (v_bound->>'agentProfileVersionId')::uuid)
    ON CONFLICT (tenant_id, lead_id, channel,
                 coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 coalesce(conversation_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET last_seen_at=clock_timestamp();
  END IF;
  INSERT INTO audit.records
    (tenant_id, actor_user_id, actor_service, action, target_type, target_id, metadata)
  VALUES (p_lead.tenant_id, (v_bound->>'actorUserId')::uuid,
          CASE WHEN v_bound->>'actorUserId' IS NULL THEN v_bound->>'actorService' END,
          p_action, 'lead', p_lead.id,
          (p_metadata - 'binding') || jsonb_build_object(
            'recordedBy', v_bound->>'recordedBy',
            'sourceChannel', v_bound->>'sourceChannel',
            'agentProfileVersionId', v_bound->>'agentProfileVersionId',
            'operationKey', btrim(p_key),
            'revision', p_lead.revision));
END
$$
"""

# The lead this interaction is already working on. Found through what the
# interaction is linked to — itself, the conversation that requested the call,
# or the handoff — never through "the contact's latest lead".
_CANDIDATE = """
CREATE FUNCTION platform.lead_interaction_candidate(p_bound jsonb, p_interest_key text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
  SELECT lead.id FROM crm.leads lead
  WHERE lead.tenant_id=(p_bound->>'tenantId')::uuid
    AND lead.contact_id=(p_bound->>'contactId')::uuid
    AND lead.archived_at IS NULL
    AND lead.status IN ('new','collecting','ready_for_review')
    AND (p_interest_key IS NULL OR lead.interest_key IS NULL
         OR lead.interest_key=p_interest_key)
    AND (
      ((p_bound->>'sessionId') IS NOT NULL
        AND (lead.source_session_id=(p_bound->>'sessionId')::uuid OR EXISTS (
          SELECT 1 FROM crm.lead_interactions link
          WHERE link.tenant_id=lead.tenant_id AND link.lead_id=lead.id
            AND link.session_id=(p_bound->>'sessionId')::uuid)))
      OR ((p_bound->>'conversationId') IS NOT NULL
        AND (lead.source_conversation_id=(p_bound->>'conversationId')::uuid OR EXISTS (
          SELECT 1 FROM crm.lead_interactions link
          WHERE link.tenant_id=lead.tenant_id AND link.lead_id=lead.id
            AND link.conversation_id=(p_bound->>'conversationId')::uuid)))
      OR ((p_bound->>'handoffId') IS NOT NULL
        AND lead.handoff_id=(p_bound->>'handoffId')::uuid)
      OR (p_interest_key IS NOT NULL AND lead.interest_key=p_interest_key)
    )
  ORDER BY
    (lead.source_session_id IS NOT DISTINCT FROM (p_bound->>'sessionId')::uuid) DESC,
    (lead.interest_key IS NOT DISTINCT FROM p_interest_key) DESC,
    lead.updated_at DESC, lead.id DESC
  LIMIT 1
$$
"""

_ENSURE = """
CREATE FUNCTION platform.lead_ensure_for_interaction(
  p_binding jsonb, p_operation_key text, p_field_schema_id uuid,
  p_field_schema_version integer, p_business_objective text, p_interest_key text,
  p_source_message_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
DECLARE
  v_bound jsonb := platform.lead_bind(p_binding, 'lead.write', false);
  v_tenant uuid := (v_bound->>'tenantId')::uuid;
  v_interest text := nullif(btrim(coalesce(p_interest_key, '')), '');
  v_objective text := nullif(btrim(coalesce(p_business_objective, '')), '');
  v_replay jsonb;
  v_existing uuid;
  v_lead crm.leads%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_receipt jsonb;
BEGIN
  IF v_interest IS NOT NULL AND length(v_interest) > 120 THEN
    RAISE EXCEPTION 'interest key is too long' USING ERRCODE='LD422';
  END IF;
  IF v_objective IS NOT NULL AND length(v_objective) > 400 THEN
    RAISE EXCEPTION 'business objective is too long' USING ERRCODE='LD422';
  END IF;
  IF (p_field_schema_id IS NULL) <> (p_field_schema_version IS NULL) THEN
    RAISE EXCEPTION 'a pinned field schema requires its version' USING ERRCODE='LD422';
  END IF;
  IF p_field_schema_id IS NOT NULL THEN
    PERFORM 1 FROM crm.lead_field_schemas
    WHERE tenant_id=v_tenant AND id=p_field_schema_id
      AND version=p_field_schema_version AND published_at IS NOT NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pinned lead field schema is unavailable' USING ERRCODE='LD404';
    END IF;
  END IF;
  IF p_source_message_id IS NOT NULL THEN
    PERFORM 1 FROM messaging.messages
    WHERE tenant_id=v_tenant AND id=p_source_message_id
      AND conversation_id=(v_bound->>'conversationId')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'source message is not part of this interaction' USING ERRCODE='LD422';
    END IF;
  END IF;
  v_replay := platform.lead_claim_operation(p_operation_key, 'lead.create', NULL);
  IF v_replay IS NOT NULL THEN
    PERFORM platform.lead_lock((v_replay->>'leadId')::uuid, v_bound);
    RETURN jsonb_build_object('receipt', v_replay, 'created', false);
  END IF;
  -- Serialize creation per contact so two channels racing on one customer
  -- converge on one lead instead of both creating one.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('lead-contact:' || v_tenant::text || ':' || (v_bound->>'contactId'), 0)
  );
  v_existing := platform.lead_interaction_candidate(v_bound, v_interest);
  IF v_existing IS NOT NULL THEN
    v_lead := platform.lead_lock(v_existing, v_bound);
    v_receipt := platform.lead_receipt(v_lead, 'lead.create', p_operation_key, ARRAY[]::text[]);
    PERFORM platform.lead_commit(p_operation_key, v_lead, v_receipt, 'lead.continued',
      jsonb_build_object('binding', v_bound));
    RETURN jsonb_build_object('receipt', v_receipt, 'created', false);
  END IF;
  INSERT INTO crm.leads
    (id, tenant_id, reference, contact_id, source_channel, source_conversation_id,
     source_message_id, source_session_id, handoff_id, agent_profile_version_id,
     field_schema_id, field_schema_version, business_objective, interest_key, status,
     created_by_user_id)
  VALUES (v_id, v_tenant, 'LD-' || upper(left(replace(v_id::text, '-', ''), 8)),
          (v_bound->>'contactId')::uuid, v_bound->>'sourceChannel',
          (v_bound->>'conversationId')::uuid, p_source_message_id,
          (v_bound->>'sessionId')::uuid, (v_bound->>'handoffId')::uuid,
          (v_bound->>'agentProfileVersionId')::uuid, p_field_schema_id,
          p_field_schema_version, v_objective, v_interest, 'collecting',
          (v_bound->>'actorUserId')::uuid)
  RETURNING * INTO v_lead;
  v_receipt := platform.lead_receipt(v_lead, 'lead.create', p_operation_key, ARRAY[]::text[]);
  PERFORM platform.lead_commit(p_operation_key, v_lead, v_receipt, 'lead.created',
    jsonb_build_object('binding', v_bound));
  RETURN jsonb_build_object('receipt', v_receipt, 'created', true);
END
$$
"""

_SAVE = """
CREATE FUNCTION platform.lead_save_fields_core(
  p_binding jsonb, p_lead_id uuid, p_operation_key text, p_expected_revision integer,
  p_observations jsonb, p_operator boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
DECLARE
  v_bound jsonb := platform.lead_bind(p_binding, 'lead.write', p_operator);
  v_tenant uuid := (v_bound->>'tenantId')::uuid;
  v_agent boolean := v_bound->>'recordedBy'='agent';
  v_replay jsonb;
  v_lead crm.leads%ROWTYPE;
  v_definition jsonb;
  v_field jsonb;
  v_observation jsonb;
  v_key text;
  v_type text;
  v_state text;
  v_raw text;
  v_value text;
  v_currency text;
  v_confirmation text;
  v_reference text;
  v_observed timestamptz;
  v_current crm.lead_field_values%ROWTYPE;
  v_has_current boolean;
  v_new uuid;
  v_changed text[] := ARRAY[]::text[];
  v_rejected jsonb := '[]'::jsonb;
  v_receipt jsonb;
BEGIN
  IF jsonb_typeof(p_observations) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_observations) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'between 1 and 40 observations are required' USING ERRCODE='LD422';
  END IF;
  v_replay := platform.lead_claim_operation(p_operation_key, 'lead.save_fields', p_lead_id);
  IF v_replay IS NOT NULL THEN
    PERFORM platform.lead_lock(p_lead_id, v_bound);
    RETURN jsonb_build_object('receipt', v_replay, 'rejected', '[]'::jsonb);
  END IF;
  v_lead := platform.lead_lock(p_lead_id, v_bound);
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> v_lead.revision THEN
    RAISE EXCEPTION 'lead was modified by another writer'
      USING ERRCODE='LD409', DETAIL=v_lead.revision::text;
  END IF;
  IF v_agent AND v_lead.status NOT IN ('new','collecting','ready_for_review') THEN
    RAISE EXCEPTION 'this lead is no longer open for collection' USING ERRCODE='LD410';
  END IF;
  SELECT definition INTO v_definition FROM crm.lead_field_schemas
  WHERE tenant_id=v_tenant AND id=v_lead.field_schema_id
    AND version=v_lead.field_schema_version;
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'this lead has no reviewed field schema to save into'
      USING ERRCODE='LD422';
  END IF;
  IF jsonb_typeof(v_definition)='object' THEN
    v_definition := v_definition->'fields';
  END IF;

  FOR v_observation IN SELECT value FROM jsonb_array_elements(p_observations) LOOP
    v_key := v_observation->>'key';
    SELECT field INTO v_field FROM jsonb_array_elements(v_definition) field
    WHERE field->>'key'=v_key;
    IF v_field IS NULL THEN
      RAISE EXCEPTION 'field % is not part of this lead''s reviewed schema', v_key
        USING ERRCODE='LD422';
    END IF;
    v_type := v_field->>'type';
    v_state := v_observation->>'state';
    v_raw := v_observation->>'rawValue';
    v_value := v_observation->>'normalizedValue';
    v_currency := v_observation->>'currency';
    v_confirmation := coalesce(v_observation->>'confirmation', 'unconfirmed');
    v_reference := nullif(btrim(coalesce(v_observation->>'sourceReferenceId', '')), '');
    -- The caller normalized against the contract; these checks keep a faulty
    -- caller from storing a shape the contract could never have produced.
    IF v_observation->>'type' IS DISTINCT FROM v_type THEN
      RAISE EXCEPTION 'field % was normalized as the wrong type', v_key USING ERRCODE='LD422';
    END IF;
    IF v_state NOT IN ('known','unknown','declined','not_applicable')
       OR v_confirmation NOT IN ('unconfirmed','customer_confirmed','human_verified') THEN
      RAISE EXCEPTION 'field % has an unsupported state', v_key USING ERRCODE='LD422';
    END IF;
    IF v_agent AND v_confirmation='human_verified' THEN
      RAISE EXCEPTION 'an agent cannot record a human verification' USING ERRCODE='LD422';
    END IF;
    IF (v_state='known') <> (v_raw IS NOT NULL AND v_value IS NOT NULL)
       OR (v_state <> 'known' AND v_currency IS NOT NULL)
       OR ((v_type='currency' AND v_state='known') <> (v_currency IS NOT NULL))
       OR (v_currency IS NOT NULL AND v_currency !~ '^[A-Z]{3}$') THEN
      RAISE EXCEPTION 'field % has an inconsistent value', v_key USING ERRCODE='LD422';
    END IF;
    -- Parenthesized: an IF condition otherwise ends at the CASE's first THEN.
    IF v_state='known' AND NOT (CASE v_type
        WHEN 'number' THEN v_value ~ '^-?[0-9]+(\\.[0-9]+)?(e[+-][0-9]+)?$'
        WHEN 'currency' THEN v_value ~ '^[0-9]+\\.[0-9]{2}$'
        WHEN 'date' THEN v_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        WHEN 'boolean' THEN v_value IN ('true','false')
        WHEN 'phone' THEN v_value ~ '^\\+[1-9][0-9]{7,14}$'
        WHEN 'email' THEN v_value ~ '^[^@]+@[^@]+$' AND v_value=lower(v_value)
        WHEN 'choice' THEN v_field->'choices' ? v_value
        ELSE true END) THEN
      RAISE EXCEPTION 'field % has a value its type cannot hold', v_key USING ERRCODE='LD422';
    END IF;
    IF v_reference IS NOT NULL AND length(v_reference) > 200 THEN
      RAISE EXCEPTION 'source reference is too long' USING ERRCODE='LD422';
    END IF;
    -- A WhatsApp agent may only cite a message of its own conversation.
    IF v_agent AND v_bound->>'sourceChannel'='whatsapp' AND v_reference IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM messaging.messages message
         WHERE message.tenant_id=v_tenant
           AND message.conversation_id=(v_bound->>'conversationId')::uuid
           AND message.id::text=v_reference) THEN
      RAISE EXCEPTION 'source reference is not part of this interaction' USING ERRCODE='LD422';
    END IF;
    BEGIN
      v_observed := (v_observation->>'observedAt')::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'field % has an invalid observation time', v_key USING ERRCODE='LD422';
    END;
    IF v_observed IS NULL THEN
      RAISE EXCEPTION 'field % has no observation time', v_key USING ERRCODE='LD422';
    END IF;

    SELECT * INTO v_current FROM crm.lead_field_values
    WHERE tenant_id=v_tenant AND lead_id=v_lead.id AND field_key=v_key
      AND superseded_at IS NULL;
    v_has_current := FOUND;
    -- A person's verification outranks any later machine extraction, however
    -- fresh: an agent re-hearing a name must not undo a correction.
    IF v_has_current AND v_current.confirmation_status='human_verified' AND v_agent THEN
      v_rejected := v_rejected || jsonb_build_object(
        'key', v_key, 'code', 'human_verified',
        'reason', 'a person has verified this value');
      CONTINUE;
    END IF;
    IF v_has_current AND v_current.value_state=v_state
       AND v_current.normalized_value IS NOT DISTINCT FROM v_value
       AND v_current.value_currency IS NOT DISTINCT FROM v_currency
       AND v_current.confirmation_status=v_confirmation THEN
      CONTINUE;
    END IF;
    v_new := gen_random_uuid();
    IF v_has_current THEN
      UPDATE crm.lead_field_values
      SET superseded_at=clock_timestamp(), superseded_by_id=v_new
      WHERE tenant_id=v_tenant AND id=v_current.id;
    END IF;
    INSERT INTO crm.lead_field_values
      (id, tenant_id, lead_id, field_key, value_state, value_type, raw_value,
       normalized_value, value_currency, source_channel, source_reference_kind,
       source_reference_id, observed_at, confirmation_status, recorded_by,
       recorded_by_user_id, agent_profile_version_id)
    VALUES (v_new, v_tenant, v_lead.id, v_key, v_state, v_type, v_raw, v_value,
            v_currency, v_bound->>'sourceChannel',
            CASE v_bound->>'sourceChannel' WHEN 'voice' THEN 'voice_turn'
              WHEN 'whatsapp' THEN 'message' ELSE v_bound->>'sourceChannel' END,
            v_reference, v_observed, v_confirmation, v_bound->>'recordedBy',
            CASE WHEN v_agent THEN NULL ELSE (v_bound->>'actorUserId')::uuid END,
            (v_bound->>'agentProfileVersionId')::uuid);
    v_changed := array_append(v_changed, v_key);
  END LOOP;

  UPDATE crm.leads
  SET revision=revision + 1,
      status=CASE WHEN status='new' THEN 'collecting' ELSE status END,
      updated_at=clock_timestamp()
  WHERE tenant_id=v_tenant AND id=v_lead.id
  RETURNING * INTO v_lead;
  v_receipt := platform.lead_receipt(v_lead, 'lead.save_fields', p_operation_key, v_changed);
  PERFORM platform.lead_commit(p_operation_key, v_lead, v_receipt, 'lead.fields_saved',
    jsonb_build_object('binding', v_bound, 'changed', to_jsonb(v_changed),
      'rejected', (SELECT coalesce(jsonb_agg(entry->'key'), '[]'::jsonb)
                   FROM jsonb_array_elements(v_rejected) entry)));
  RETURN jsonb_build_object('receipt', v_receipt, 'rejected', v_rejected);
END
$$
"""

_SAVE_ENTRY_POINTS = (
    """
CREATE FUNCTION platform.lead_save_fields(
  p_binding jsonb, p_lead_id uuid, p_operation_key text, p_expected_revision integer,
  p_observations jsonb
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
  SELECT platform.lead_save_fields_core(
    p_binding, p_lead_id, p_operation_key, p_expected_revision, p_observations, false)
$$
""",
    """
CREATE FUNCTION platform.lead_operator_save_fields(
  p_binding jsonb, p_lead_id uuid, p_operation_key text, p_expected_revision integer,
  p_observations jsonb
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
  SELECT platform.lead_save_fields_core(
    p_binding, p_lead_id, p_operation_key, p_expected_revision, p_observations, true)
$$
""",
)

_FINALIZE = """
CREATE FUNCTION platform.lead_finalize(
  p_binding jsonb, p_lead_id uuid, p_operation_key text, p_expected_revision integer,
  p_summary text, p_next_action text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
DECLARE
  v_bound jsonb := platform.lead_bind(p_binding, 'lead.finalize', false);
  v_summary text := btrim(coalesce(p_summary, ''));
  v_next text := nullif(btrim(coalesce(p_next_action, '')), '');
  v_replay jsonb;
  v_lead crm.leads%ROWTYPE;
  v_receipt jsonb;
BEGIN
  IF length(v_summary) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'a finalization summary of 1-4000 characters is required'
      USING ERRCODE='LD422';
  END IF;
  IF v_next IS NOT NULL AND length(v_next) > 1000 THEN
    RAISE EXCEPTION 'next action is too long' USING ERRCODE='LD422';
  END IF;
  v_replay := platform.lead_claim_operation(p_operation_key, 'lead.finalize', p_lead_id);
  IF v_replay IS NOT NULL THEN
    PERFORM platform.lead_lock(p_lead_id, v_bound);
    RETURN jsonb_build_object('receipt', v_replay);
  END IF;
  v_lead := platform.lead_lock(p_lead_id, v_bound);
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> v_lead.revision THEN
    RAISE EXCEPTION 'lead was modified by another writer'
      USING ERRCODE='LD409', DETAIL=v_lead.revision::text;
  END IF;
  IF v_lead.status NOT IN ('new','collecting','ready_for_review') THEN
    RAISE EXCEPTION 'this lead is no longer open for collection' USING ERRCODE='LD410';
  END IF;
  -- Collection completeness is not sales qualification: finalizing hands the
  -- lead to a person for review, it never declares the lead qualified.
  UPDATE crm.leads
  SET status='ready_for_review', summary=v_summary, next_action=v_next,
      revision=revision + 1, updated_at=clock_timestamp()
  WHERE tenant_id=v_lead.tenant_id AND id=v_lead.id
  RETURNING * INTO v_lead;
  v_receipt := platform.lead_receipt(v_lead, 'lead.finalize', p_operation_key,
                                     ARRAY['status','summary']);
  PERFORM platform.lead_commit(p_operation_key, v_lead, v_receipt, 'lead.finalized',
    jsonb_build_object('binding', v_bound));
  RETURN jsonb_build_object('receipt', v_receipt);
END
$$
"""

_FOLLOW_UP = """
CREATE FUNCTION platform.lead_request_follow_up(
  p_binding jsonb, p_lead_id uuid, p_operation_key text, p_note text, p_due_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
DECLARE
  v_bound jsonb := platform.lead_bind(p_binding, 'lead.follow_up', false);
  v_note text := btrim(coalesce(p_note, ''));
  v_replay jsonb;
  v_lead crm.leads%ROWTYPE;
  v_receipt jsonb;
BEGIN
  IF length(v_note) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'a follow-up note of 1-1000 characters is required'
      USING ERRCODE='LD422';
  END IF;
  v_replay := platform.lead_claim_operation(
    p_operation_key, 'lead.request_follow_up', p_lead_id);
  IF v_replay IS NOT NULL THEN
    PERFORM platform.lead_lock(p_lead_id, v_bound);
    RETURN jsonb_build_object('receipt', v_replay);
  END IF;
  v_lead := platform.lead_lock(p_lead_id, v_bound);
  UPDATE crm.leads
  SET next_action=v_note, next_action_due_at=p_due_at,
      revision=revision + 1, updated_at=clock_timestamp()
  WHERE tenant_id=v_lead.tenant_id AND id=v_lead.id
  RETURNING * INTO v_lead;
  v_receipt := platform.lead_receipt(v_lead, 'lead.request_follow_up', p_operation_key,
                                     ARRAY['nextAction']);
  PERFORM platform.lead_commit(p_operation_key, v_lead, v_receipt,
    'lead.follow_up_requested', jsonb_build_object('binding', v_bound));
  RETURN jsonb_build_object('receipt', v_receipt);
END
$$
"""

_STATE = """
CREATE FUNCTION platform.lead_capture_state(
  p_binding jsonb, p_lead_id uuid, p_interest_key text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
DECLARE
  v_bound jsonb := platform.lead_bind(p_binding, 'lead.read', false);
  v_tenant uuid := (v_bound->>'tenantId')::uuid;
  v_id uuid := coalesce(
    p_lead_id,
    platform.lead_interaction_candidate(
      v_bound, nullif(btrim(coalesce(p_interest_key, '')), '')));
  v_lead crm.leads%ROWTYPE;
BEGIN
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_lead FROM crm.leads
  WHERE tenant_id=v_tenant AND id=v_id AND archived_at IS NULL;
  IF NOT FOUND OR v_lead.contact_id <> (v_bound->>'contactId')::uuid THEN
    RAISE EXCEPTION 'lead is not available for this tenant and interaction'
      USING ERRCODE='LD404';
  END IF;
  RETURN jsonb_build_object(
    'lead', jsonb_build_object(
      'id', v_lead.id, 'reference', v_lead.reference, 'contactId', v_lead.contact_id,
      'status', v_lead.status, 'revision', v_lead.revision,
      'businessObjective', v_lead.business_objective, 'interestKey', v_lead.interest_key,
      'summary', v_lead.summary, 'nextAction', v_lead.next_action,
      'sourceChannel', v_lead.source_channel,
      'agentProfileVersionId', v_lead.agent_profile_version_id,
      'fieldSchemaId', v_lead.field_schema_id,
      'fieldSchemaVersion', v_lead.field_schema_version),
    'schema', (SELECT definition FROM crm.lead_field_schemas
               WHERE tenant_id=v_tenant AND id=v_lead.field_schema_id
                 AND version=v_lead.field_schema_version),
    'fields', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'key', value.field_key, 'type', value.value_type, 'state', value.value_state,
        'rawValue', value.raw_value, 'normalizedValue', value.normalized_value,
        'currency', value.value_currency, 'confirmation', value.confirmation_status,
        'observedAt', value.observed_at, 'sourceChannel', value.source_channel,
        'sourceReferenceId', value.source_reference_id, 'recordedBy', value.recorded_by)
        ORDER BY value.field_key)
      FROM crm.lead_field_values value
      WHERE value.tenant_id=v_tenant AND value.lead_id=v_lead.id
        AND value.superseded_at IS NULL), '[]'::jsonb)
  );
END
$$
"""

_OPERATION = """
CREATE FUNCTION platform.lead_operation_receipt(p_binding jsonb, p_operation_key text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,crm,messaging,agents,automation,audit,platform AS $$
DECLARE
  v_bound jsonb := platform.lead_bind(p_binding, 'lead.read', false);
  v_receipt jsonb;
BEGIN
  SELECT operation.receipt INTO v_receipt
  FROM crm.lead_operations operation
  JOIN crm.leads lead
    ON lead.tenant_id=operation.tenant_id AND lead.id=operation.lead_id
  WHERE operation.tenant_id=(v_bound->>'tenantId')::uuid
    AND operation.operation_key=btrim(p_operation_key)
    AND operation.status='committed'
    AND lead.contact_id=(v_bound->>'contactId')::uuid;
  RETURN CASE WHEN v_receipt IS NULL THEN NULL
    ELSE v_receipt || jsonb_build_object('status', 'replayed') END;
END
$$
"""


# The operator workspace shows how many calls are running each agent version.
# It needs that count, not the admission events themselves, which carry
# verification outcomes the workspace role has no reason to read.
_RUNNING_CALLS = """
CREATE FUNCTION platform.current_tenant_running_agent_calls()
RETURNS TABLE(agent_profile_version_id uuid, running bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,platform AS $$
  SELECT (admission.payload->>'agent_version_id')::uuid,
         count(DISTINCT session.session_id)
  FROM public.sessions session
  JOIN public.session_events admission
    ON admission.tenant_id=session.tenant_id
   AND admission.session_id=session.session_id
   AND admission.event_type='voice.call.admission.v1'
  WHERE session.tenant_id=platform.current_tenant_id()
    AND session.status='started' AND session.ended_at IS NULL
    AND admission.payload->>'agent_version_id'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  GROUP BY 1
$$
"""
_RUNNING_CALLS_FUNCTION = "platform.current_tenant_running_agent_calls()"


def upgrade() -> None:
    # Opening a support ticket on escalation becomes an explicit capability
    # (``ticket.open``). A version published before capabilities existed was
    # published with that behaviour, and a published version's behaviour does
    # not change after the fact, so existing rows keep it; every version
    # created from now on must be granted it. Adding the column with a default
    # does not fire the published-version immutability trigger.
    op.add_column(
        "agent_profile_versions",
        sa.Column(
            "implicit_ticketing",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        schema="agents",
    )
    op.alter_column(
        "agent_profile_versions",
        "implicit_ticketing",
        server_default=sa.text("false"),
        schema="agents",
    )
    op.create_table(
        "lead_interactions",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("lead_id", sa.UUID(), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("conversation_id", sa.UUID(), nullable=True),
        sa.Column("session_id", sa.UUID(), nullable=True),
        sa.Column("handoff_id", sa.UUID(), nullable=True),
        sa.Column("agent_profile_version_id", sa.UUID(), nullable=True),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint("channel IN ('voice','whatsapp')", name="ck_lead_interaction_channel"),
        sa.CheckConstraint(
            "(channel = 'voice') = (session_id IS NOT NULL)",
            name="ck_lead_interaction_voice_has_session",
        ),
        sa.CheckConstraint(
            "channel <> 'whatsapp' OR conversation_id IS NOT NULL",
            name="ck_lead_interaction_whatsapp_has_conversation",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "lead_id"],
            ["crm.leads.tenant_id", "crm.leads.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "conversation_id"],
            ["messaging.conversations.tenant_id", "messaging.conversations.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_profile_version_id"],
            ["agents.agent_profile_versions.tenant_id", "agents.agent_profile_versions.id"],
            ondelete="SET NULL",
        ),
        schema="crm",
    )
    op.execute(
        """
        CREATE UNIQUE INDEX uq_lead_interactions_link ON crm.lead_interactions
          (tenant_id, lead_id, channel,
           coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid),
           coalesce(conversation_id, '00000000-0000-0000-0000-000000000000'::uuid))
        """
    )
    op.create_index(
        "ix_lead_interactions_session",
        "lead_interactions",
        ["tenant_id", "session_id"],
        postgresql_where=sa.text("session_id IS NOT NULL"),
        schema="crm",
    )
    op.create_index(
        "ix_lead_interactions_conversation",
        "lead_interactions",
        ["tenant_id", "conversation_id"],
        postgresql_where=sa.text("conversation_id IS NOT NULL"),
        schema="crm",
    )
    op.execute("ALTER TABLE crm.lead_interactions ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE crm.lead_interactions FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY lead_interactions_tenant_isolation ON crm.lead_interactions "
        "USING (tenant_id = platform.current_tenant_id()) "
        "WITH CHECK (tenant_id = platform.current_tenant_id())"
    )

    for statement in (
        _BIND,
        _CLAIM,
        _LOCK,
        _RECEIPT,
        _COMMIT,
        _CANDIDATE,
        _ENSURE,
        _SAVE,
        *_SAVE_ENTRY_POINTS,
        _FINALIZE,
        _FOLLOW_UP,
        _STATE,
        _OPERATION,
    ):
        op.execute(statement)
    for function in (*_INTERNAL_FUNCTIONS, *_PUBLIC_FUNCTIONS, *_OPERATOR_FUNCTIONS):
        op.execute(f"REVOKE ALL ON FUNCTION {function} FROM PUBLIC")
    for function in _PUBLIC_FUNCTIONS:
        for role in _CALLER_ROLES:
            op.execute(f"GRANT EXECUTE ON FUNCTION {function} TO {role}")
    for function in _OPERATOR_FUNCTIONS:
        op.execute(f"GRANT EXECUTE ON FUNCTION {function} TO platform_web")
    op.execute(_RUNNING_CALLS)
    op.execute(f"REVOKE ALL ON FUNCTION {_RUNNING_CALLS_FUNCTION} FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION {_RUNNING_CALLS_FUNCTION} TO platform_web")

    # The functions above are now the only lead write path. Field history and
    # operation receipts are append-only through them; the operator workspace
    # keeps UPDATE on crm.leads for audited management edits (status, owner).
    for role in _CALLER_ROLES:
        op.execute(
            f"REVOKE INSERT, UPDATE, DELETE ON crm.lead_field_values, crm.lead_operations "
            f"FROM {role}"
        )
        op.execute(f"REVOKE INSERT ON crm.leads FROM {role}")
    for role in _RUNTIME_ROLES:
        op.execute(f"REVOKE UPDATE ON crm.leads FROM {role}")
    for role in (*_CALLER_ROLES, "platform_readonly"):
        op.execute(f"GRANT SELECT ON crm.lead_interactions TO {role}")


def downgrade() -> None:
    for role in _RUNTIME_ROLES:
        op.execute(
            "GRANT SELECT, INSERT, UPDATE ON crm.leads, crm.lead_field_values, "
            f"crm.lead_operations TO {role}"
        )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON crm.leads, crm.lead_field_values, "
        "crm.lead_operations TO platform_web"
    )
    for function in (
        _RUNNING_CALLS_FUNCTION,
        *_OPERATOR_FUNCTIONS,
        *_PUBLIC_FUNCTIONS,
        *reversed(_INTERNAL_FUNCTIONS),
    ):
        op.execute(f"DROP FUNCTION {function}")
    op.drop_table("lead_interactions", schema="crm")
    op.drop_column("agent_profile_versions", "implicit_ticketing", schema="agents")
