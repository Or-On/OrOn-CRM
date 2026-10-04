"""Server-attested, consented and independently reviewed cross-channel memory."""

from alembic import op
from sqlalchemy.schema import DDL

revision = "f71f396aec5b"
down_revision = "f60e2859db4a"
branch_labels = None
depends_on = None


def _execute(script):
    pending = ""
    for index, part in enumerate(script.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
            continue
        pieces = part.split(";")
        pending += pieces[0]
        for piece in pieces[1:]:
            if pending.strip():
                op.execute(DDL(pending.replace("%", "%%")))
            pending = piece
    if pending.strip():
        op.execute(DDL(pending.replace("%", "%%")))


def upgrade():
    _execute(r"""
DO $$
DECLARE definition text; anchor text:='''audio_transcription''::text';
BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
 WHERE conrelid='platform.tenant_remediation_flags'::regclass
 AND conname='tenant_remediation_flags_flag_key_check' AND contype='c';
 IF definition IS NULL OR
 (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1
 OR position('verified_voice_memory_bridge' IN definition)>0 THEN
 RAISE EXCEPTION 'remediation flag constraint drift'; END IF;
 definition:=replace(definition,anchor,anchor||', ''verified_voice_memory_bridge''::text');
 ALTER TABLE platform.tenant_remediation_flags DROP CONSTRAINT
 tenant_remediation_flags_flag_key_check;
 EXECUTE 'ALTER TABLE platform.tenant_remediation_flags ADD CONSTRAINT '
 ||'tenant_remediation_flags_flag_key_check '||definition;
END $$;
ALTER TABLE agents.messaging_memory_sessions ADD COLUMN ownership_epoch bigint;
CREATE FUNCTION agents.guard_memory_session_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
 SELECT ownership_epoch INTO NEW.ownership_epoch FROM messaging.conversations
 WHERE id=NEW.conversation_id AND tenant_id=NEW.tenant_id;
 IF NEW.ownership_epoch IS NULL THEN RAISE EXCEPTION 'memory epoch scope denied' USING
ERRCODE='42501'; END IF;
 ELSIF NEW.ownership_epoch IS DISTINCT FROM OLD.ownership_epoch THEN
 RAISE EXCEPTION 'memory epoch is immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION agents.guard_memory_session_epoch() FROM PUBLIC;
CREATE TRIGGER memory_session_epoch BEFORE INSERT OR UPDATE ON agents.messaging_memory_sessions
FOR EACH ROW EXECUTE FUNCTION agents.guard_memory_session_epoch();
DO $$
DECLARE definition text;
 resolver_anchor text:='AND s.agent_version_id=p_agent';
 correction_anchor text:='WHERE session.id=p_session';
 admission_anchor text:='WHERE session.tenant_id=c.tenant_id AND session.conversation_id=c.id';
BEGIN
 SELECT pg_get_functiondef(
 'agents.resolve_messaging_memory_session(uuid,uuid,integer)'::regprocedure) INTO definition;
 IF (length(definition)-length(replace(definition,resolver_anchor,'')))
 /length(resolver_anchor)<>1 THEN
 RAISE EXCEPTION 'memory resolver upgrade anchor changed'; END IF;
 EXECUTE replace(definition,resolver_anchor,resolver_anchor||
 ' AND s.ownership_epoch=(SELECT epoch_conversation.ownership_epoch'||
 ' FROM messaging.conversations epoch_conversation WHERE epoch_conversation.id=p_conversation'||
 ' AND epoch_conversation.tenant_id=platform.current_tenant_id())');
 SELECT pg_get_functiondef(
 'platform.admit_messaging_session_agent(uuid,text,uuid,integer)'::regprocedure) INTO definition;
 IF (length(definition)-length(replace(definition,admission_anchor,'')))
 /length(admission_anchor)<>1 THEN
 RAISE EXCEPTION 'memory admission upgrade anchor changed'; END IF;
 EXECUTE replace(definition,admission_anchor,admission_anchor||
 ' AND session.ownership_epoch=c.ownership_epoch');
 SELECT pg_get_functiondef('agents.read_session_memory_corrections(uuid,uuid)'::regprocedure)
 INTO definition;
 IF (length(definition)-length(replace(definition,correction_anchor,'')))
 /length(correction_anchor)<>1 THEN
 RAISE EXCEPTION 'correction projection upgrade anchor changed'; END IF;
 EXECUTE replace(definition,'WHERE session.id=p_session',
 'WHERE session.id=p_session AND session.ownership_epoch=conversation.ownership_epoch');
END $$;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE
rolname='platform_whatsapp_verifier') THEN
 CREATE ROLE platform_whatsapp_verifier NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
NOCREATEROLE NOCREATEDB NOREPLICATION;
 ELSIF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='platform_whatsapp_verifier'
 AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR
rolreplication))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=(SELECT oid FROM
pg_catalog.pg_roles WHERE rolname='platform_whatsapp_verifier')
 OR member=(SELECT oid FROM pg_catalog.pg_roles WHERE
rolname='platform_whatsapp_verifier')) THEN
 RAISE EXCEPTION 'hostile memory review capability role';
 END IF;
END $$;
CREATE TABLE agents.whatsapp_verified_receipts(
 inbound_event_id uuid PRIMARY KEY REFERENCES ops.inbound_events(id) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 provider_account_id text NOT NULL,
 sender_address text NOT NULL,
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 raw_body_digest text NOT NULL CHECK(raw_body_digest ~ '^[a-f0-9]{64}$'),
 attested_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE agents.whatsapp_verified_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.whatsapp_verified_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY no_direct_signature_proofs ON agents.whatsapp_verified_receipts USING(false);
CREATE FUNCTION agents.attest_whatsapp_signature(p_event uuid,p_raw_digest text,p_expected jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE receipt ops.inbound_events%ROWTYPE;
BEGIN
 IF p_expected IS NULL OR jsonb_typeof(p_expected)<>'object'
 OR p_raw_digest IS NULL OR p_raw_digest !~ '^[a-f0-9]{64}$' THEN
 RAISE EXCEPTION 'invalid signature acquisition digest' USING ERRCODE='22023'; END IF;
 SELECT event.* INTO receipt FROM ops.inbound_events event
 JOIN messaging.channels channel ON channel.tenant_id=event.tenant_id
 AND channel.provider_account_id=event.provider_account_id AND channel.provider='meta'
 JOIN public.tenants tenant ON tenant.id=event.tenant_id
 WHERE event.id=p_event AND event.provider='meta' AND event.payload=p_expected
 AND channel.status='active'
 AND tenant.status='active' AND event.event_type<>'whatsapp.message.status'
 AND event.payload->>'providerAccountId'=event.provider_account_id
 AND event.payload->>'from' ~ '^\+?[1-9][0-9]{7,14}$'
 FOR SHARE OF event,channel,tenant;
 IF receipt.id IS NULL THEN RAISE EXCEPTION 'canonical inbound signature scope denied' USING
ERRCODE='42501'; END IF;
 INSERT INTO
agents.whatsapp_verified_receipts(inbound_event_id,tenant_id,provider_account_id,sender_address,payload_digest,raw_body_digest)
 VALUES(receipt.id,receipt.tenant_id,receipt.provider_account_id,receipt.payload->>'from',
 encode(sha256(convert_to(receipt.payload::text,'UTF8')),'hex'),p_raw_digest)
 ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM agents.whatsapp_verified_receipts proof WHERE
proof.inbound_event_id=receipt.id
 AND proof.tenant_id=receipt.tenant_id AND proof.provider_account_id=receipt.provider_account_id
 AND proof.sender_address=receipt.payload->>'from'
 AND proof.payload_digest=encode(sha256(convert_to(receipt.payload::text,'UTF8')),'hex')) THEN
 RAISE EXCEPTION 'signature replay provenance changed' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION agents.attest_whatsapp_signature(uuid,text,jsonb) FROM PUBLIC;
GRANT USAGE ON SCHEMA agents TO platform_whatsapp_verifier;
GRANT EXECUTE ON FUNCTION agents.attest_whatsapp_signature(uuid,text,jsonb) TO
platform_whatsapp_verifier;
CREATE FUNCTION agents.read_conversation_memory_corrections(p_conversation uuid,p_agent uuid)
RETURNS TABLE(id uuid,fact_key text,fact_value text,operation text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT DISTINCT ON(correction.fact_key)
 correction.id,correction.fact_key,correction.fact_value,correction.operation
 FROM messaging.conversations conversation
 JOIN agents.agent_profile_versions agent ON agent.id=conversation.ai_agent_profile_version_id
 AND agent.tenant_id=conversation.tenant_id
 JOIN agents.agent_profiles profile ON profile.id=agent.agent_profile_id
 AND profile.tenant_id=agent.tenant_id
 JOIN crm.contacts contact ON contact.id=conversation.contact_id
 AND contact.tenant_id=conversation.tenant_id
 JOIN agents.memory_fact_corrections correction ON correction.contact_id=contact.id
 AND correction.tenant_id=conversation.tenant_id
 WHERE conversation.id=p_conversation AND conversation.tenant_id=platform.current_tenant_id()
 AND platform.current_tenant_active() AND agent.id=p_agent
 AND agent.published_at IS NOT NULL AND agent.validation_status='valid'
 AND profile.archived_at IS NULL AND contact.lifecycle_status='active'
 AND conversation.ownership_mode='ai' AND conversation.removed_from_inbox_at IS NULL
 AND platform.messaging_ai_actor_authorized(conversation.ai_enabled_by_user_id)
 ORDER BY correction.fact_key,correction.created_at DESC,correction.id DESC
$$;
REVOKE ALL ON FUNCTION agents.read_conversation_memory_corrections(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agents.read_conversation_memory_corrections(uuid,uuid)
 TO platform_messaging;

CREATE FUNCTION agents.read_verified_voice_memory(p_session uuid,p_agent uuid,p_trigger uuid)
RETURNS TABLE(id uuid,source_session_id uuid,text text,watermark uuid,
 source_session_started_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH approved_destination AS (
 SELECT conversation.tenant_id,conversation.contact_id,current_agent.id agent_id,
 conversation.id conversation_id
 FROM agents.messaging_memory_sessions memory
 JOIN messaging.conversations conversation ON conversation.id=memory.conversation_id AND
conversation.tenant_id=memory.tenant_id
 JOIN messaging.channels channel ON channel.id=conversation.channel_id AND
channel.tenant_id=conversation.tenant_id
 JOIN crm.contacts contact ON contact.id=conversation.contact_id AND
contact.tenant_id=conversation.tenant_id
 JOIN agents.agent_profile_versions current_agent ON
current_agent.id=conversation.ai_agent_profile_version_id AND
current_agent.tenant_id=conversation.tenant_id
 JOIN agents.agent_profiles profile ON profile.id=current_agent.agent_profile_id AND
profile.tenant_id=current_agent.tenant_id
 JOIN messaging.messages trigger ON trigger.id=p_trigger AND
trigger.conversation_id=conversation.id AND trigger.tenant_id=conversation.tenant_id
 JOIN messaging.inbound_message_origins origin ON origin.message_id=trigger.id AND
origin.tenant_id=trigger.tenant_id
 JOIN crm.contact_channel_identities identity ON identity.id=origin.contact_identity_id AND
identity.tenant_id=conversation.tenant_id AND identity.contact_id=conversation.contact_id
 JOIN ops.inbound_events event ON event.tenant_id=trigger.tenant_id AND event.provider='meta' AND
event.provider_account_id=channel.provider_account_id AND
event.payload->>'providerMessageId'=trigger.provider_message_id
 JOIN agents.whatsapp_verified_receipts proof ON proof.inbound_event_id=event.id AND
proof.tenant_id=event.tenant_id
 WHERE memory.id=p_session AND memory.tenant_id=platform.current_tenant_id() AND
memory.agent_version_id=p_agent
 AND memory.ownership_epoch=conversation.ownership_epoch
 AND current_agent.id=p_agent AND current_agent.published_at IS NOT NULL AND
current_agent.validation_status='valid' AND profile.archived_at IS NULL
 AND channel.provider='meta' AND channel.status='active' AND conversation.ownership_mode='ai' AND
conversation.removed_from_inbox_at IS NULL
 AND platform.messaging_ai_actor_authorized(conversation.ai_enabled_by_user_id)
 AND platform.current_tenant_active() AND platform.current_tenant_feature_enabled('whatsapp')
 AND 'whatsapp'=ANY(current_agent.channel_capabilities)
 AND agents.reviewed_memory_active()
 AND EXISTS(SELECT 1 FROM platform.tenant_remediation_flags bridge_flag
 WHERE bridge_flag.tenant_id=conversation.tenant_id
 AND bridge_flag.flag_key='verified_voice_memory_bridge' AND bridge_flag.enabled)
 AND EXISTS(SELECT 1 FROM platform.tenant_remediation_flags memory_flag
 WHERE memory_flag.tenant_id=conversation.tenant_id
 AND memory_flag.flag_key='session_memory' AND memory_flag.enabled)
 AND contact.whatsapp_consent='granted' AND contact.voice_consent='granted' AND
contact.lifecycle_status='active'
 AND trigger.direction='inbound' AND trigger.sender_type='contact' AND trigger.provider='meta'
 AND identity.channel='whatsapp' AND identity.validation_status NOT IN('invalid','revoked')
 AND
regexp_replace(identity.normalized_value,'^\+','','g')=regexp_replace(proof.sender_address,'^\+','','g')
 AND origin.sender_address=proof.sender_address AND
proof.provider_account_id=channel.provider_account_id
 AND proof.payload_digest=encode(sha256(convert_to(event.payload::text,'UTF8')),'hex')
 AND NOT EXISTS(SELECT 1 FROM messaging.messages newer WHERE newer.conversation_id=conversation.id
AND newer.tenant_id=conversation.tenant_id
 AND newer.direction='inbound' AND newer.sender_type='contact' AND
(newer.created_at,newer.id)>(trigger.created_at,trigger.id))
 ), eligible AS (
 SELECT DISTINCT ON(request.session_id)
request.id,request.session_id,request.summary_text,request.watermark,request.created_at,
 voice.created_at source_session_started_at
 FROM approved_destination destination
 JOIN public.sessions voice ON voice.tenant_id=destination.tenant_id AND
voice.contact_id=destination.contact_id AND voice.ended_at IS NOT NULL
 JOIN agents.memory_summary_requests request ON request.tenant_id=voice.tenant_id AND
request.session_id=voice.session_id AND request.channel='voice' AND request.state='complete'
 JOIN agents.memory_human_reviews review ON review.request_id=request.id AND
review.tenant_id=request.tenant_id AND review.approved AND review.rubric='memory.v1'
 JOIN agents.memory_real_source_attestations source ON source.request_id=request.id AND
source.tenant_id=request.tenant_id
 JOIN automation.voice_identity_verifications verification ON
verification.tenant_id=voice.tenant_id AND verification.session_id=voice.session_id AND
verification.contact_id=destination.contact_id
 JOIN public.session_events binding ON binding.tenant_id=voice.tenant_id AND
binding.session_id=voice.session_id AND binding.event_type='voice.agent.binding.v1'
 JOIN public.session_events flow_binding ON flow_binding.tenant_id=voice.tenant_id AND
flow_binding.session_id=voice.session_id AND flow_binding.event_type='voice.flow.binding.v1'
 JOIN agents.agent_profile_versions voice_agent ON voice_agent.id=request.agent_version_id AND
voice_agent.tenant_id=request.tenant_id
 JOIN agents.agent_profiles voice_profile ON voice_profile.id=voice_agent.agent_profile_id AND
voice_profile.tenant_id=voice_agent.tenant_id
 JOIN automation.flow_versions flow ON flow.tenant_id=destination.tenant_id AND
flow.agent_profile_version_id=destination.agent_id AND flow.published_at IS NOT NULL AND
flow.validation_status='valid'
 JOIN automation.flow_definitions definition ON definition.id=flow.flow_definition_id AND
definition.tenant_id=flow.tenant_id AND definition.archived_at IS NULL
 CROSS JOIN LATERAL jsonb_array_elements(flow.definition->'nodes') node
 WHERE voice_agent.agent_profile_id=(SELECT agent_profile_id FROM agents.agent_profile_versions
WHERE id=destination.agent_id AND tenant_id=destination.tenant_id)
 AND platform.approved_flow_for_channel(flow.id,destination.agent_id,'whatsapp')
 AND platform.current_tenant_feature_enabled('voice')
 AND verification.state='context_unlocked' AND verification.verified_at IS NOT NULL AND
verification.context_unlocked_at IS NOT NULL
 AND verification.sms_required AND verification.sms_verified_at IS NOT NULL
 AND verification.sms_verified_at<=verification.context_unlocked_at
 AND cardinality(request.source_ids)=(SELECT count(*) FROM agents.voice_memory_turns turn
 WHERE turn.id=ANY(request.source_ids) AND turn.tenant_id=request.tenant_id AND
turn.session_id=request.session_id
 AND turn.agent_version_id=request.agent_version_id AND turn.identity_verified AND
turn.verified_contact_id=destination.contact_id
 AND turn.created_at>=verification.sms_verified_at)
 AND NOT EXISTS(SELECT 1 FROM unnest(request.source_ids) source_id GROUP BY source_id HAVING
count(*)>1)
 AND service.voice_session_caller_identity(voice.tenant_id,voice.session_id) IS NOT NULL
 AND EXISTS(SELECT 1 FROM platform.sms_otp_challenges otp WHERE otp.tenant_id=voice.tenant_id AND
otp.voice_session_id=voice.session_id AND otp.contact_id=destination.contact_id
 AND otp.purpose='voice_identity' AND otp.state='consumed' AND otp.consumed_at IS NOT NULL
 AND otp.consumed_at<=(SELECT min(created_at) FROM agents.voice_memory_turns turn WHERE
turn.id=ANY(request.source_ids) AND turn.tenant_id=request.tenant_id AND
turn.session_id=request.session_id)
 AND otp.phone_e164=(SELECT normalized_value FROM crm.contact_channel_identities caller WHERE
caller.tenant_id=voice.tenant_id
 AND caller.contact_id=voice.contact_id AND
caller.id=service.voice_session_caller_identity(voice.tenant_id,voice.session_id)))
 AND voice_agent.published_at IS NOT NULL AND voice_agent.validation_status='valid' AND
voice_profile.archived_at IS NULL
 AND binding.payload->>'agent_version_id'=voice_agent.id::text
 AND flow_binding.payload->>'agent_version_id'=voice_agent.id::text
 AND node->>'type'='voice.call' AND node#>>'{configuration,flowId}'=voice.flow_id::text
 AND flow_binding.payload->>'compiled_flow_id'=node#>>'{configuration,flowId}'
 AND flow_binding.payload->>'compiled_flow_version'=node#>>'{configuration,flowVersion}'
 AND ((node#>>'{configuration,agentVersionId}' IS NULL AND voice_agent.id=destination.agent_id) OR
node#>>'{configuration,agentVersionId}'=voice_agent.id::text)
 ORDER BY request.session_id,request.created_at DESC,request.id DESC
 ) SELECT id,session_id,summary_text,watermark,source_session_started_at FROM eligible
 ORDER BY source_session_started_at DESC,session_id DESC
LIMIT 3
$$;
REVOKE ALL ON FUNCTION agents.read_verified_voice_memory(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agents.read_verified_voice_memory(uuid,uuid,uuid) TO platform_messaging;
""")


def downgrade():
    raise RuntimeError("Removing signature proof requires reviewed retention")
