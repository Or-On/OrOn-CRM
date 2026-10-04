"""Expose model v2 envelope only under canonical current AI job authority."""

from alembic import op
from sqlalchemy.schema import DDL as SchemaDDL

revision = "f2ca8415970c"
down_revision = "f1b9730486fb"
branch_labels = None
depends_on = None
SIGNATURE = "platform.messaging_model_credential(uuid,text,uuid,uuid,uuid,uuid,uuid,bigint,uuid)"
SQL = """
CREATE FUNCTION platform.messaging_model_credential(
 p_job uuid,p_worker text,p_token uuid,p_agent uuid,p_configuration uuid,
 p_credential uuid,p_actor uuid,p_epoch bigint,p_trigger uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 conversation messaging.conversations%ROWTYPE;
 channel messaging.channels%ROWTYPE;
 latest_trigger uuid;
 envelope jsonb;
BEGIN
 IF platform.current_tenant_id() IS NULL THEN RETURN NULL; END IF;
 SELECT c.* INTO conversation FROM ops.jobs j
 JOIN messaging.conversations c ON c.tenant_id=j.tenant_id AND c.id=j.reference_id
 JOIN agents.agent_profile_versions a ON a.tenant_id=c.tenant_id
   AND a.id=c.ai_agent_profile_version_id AND a.id=p_agent
 JOIN agents.agent_profiles profile ON profile.tenant_id=a.tenant_id
   AND profile.id=a.agent_profile_id AND profile.archived_at IS NULL
 JOIN public.tenants t ON t.id=j.tenant_id AND t.status='active'
 WHERE j.tenant_id=platform.current_tenant_id() AND j.id=p_job
   AND j.queue='messaging' AND j.job_type='whatsapp.ai.reply' AND j.status='running'
   AND j.reference_type='conversation' AND j.locked_by=p_worker AND j.claim_token=p_token
   AND j.lease_expires_at>clock_timestamp() AND j.admitted_agent_version_id=p_agent
   AND j.payload->>'conversationId'=c.id::text
   AND j.payload->>'triggerMessageId'=p_trigger::text
   AND c.ownership_mode='ai' AND c.removed_from_inbox_at IS NULL
   AND c.ownership_epoch=p_epoch AND c.ai_enabled_by_user_id=p_actor
   AND a.published_at IS NOT NULL AND a.validation_status='valid'
   AND 'whatsapp'=ANY(a.channel_capabilities) AND a.model_configuration_id=p_configuration
   AND platform.messaging_ai_actor_authorized(p_actor)
   AND platform.current_tenant_feature_enabled('whatsapp');
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT c.* INTO channel FROM messaging.channels c
 WHERE c.tenant_id=platform.current_tenant_id() AND c.id=conversation.channel_id
   AND c.kind='whatsapp' AND c.status='active' AND c.provider IN ('meta','simulator');
 IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT message.id INTO latest_trigger FROM messaging.messages message
    LEFT JOIN ops.inbound_events event ON event.tenant_id=message.tenant_id
      AND event.provider=message.provider
        AND event.provider_account_id=channel.provider_account_id
      AND event.payload->>'providerMessageId'=message.provider_message_id
    WHERE message.tenant_id=platform.current_tenant_id()
      AND message.conversation_id=conversation.id AND message.direction='inbound'
      AND message.content_type<>'event'
    ORDER BY COALESCE(event.received_at,message.created_at) DESC,
      event.receipt_sequence DESC NULLS LAST,message.created_at DESC,
      message.updated_at DESC,message.id DESC LIMIT 1;
  IF latest_trigger IS DISTINCT FROM p_trigger OR NOT EXISTS (
    SELECT 1 FROM messaging.messages m WHERE m.tenant_id=platform.current_tenant_id()
      AND m.id=p_trigger AND m.conversation_id=conversation.id
      AND m.direction='inbound' AND m.status='received'
  ) THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM messaging.messages m
    JOIN messaging.inbound_message_origins origin
      ON origin.tenant_id=m.tenant_id AND origin.message_id=m.id
    JOIN ops.inbound_events event ON event.tenant_id=m.tenant_id AND event.provider='meta'
      AND event.provider_account_id=channel.provider_account_id
      AND event.payload->>'providerMessageId'=m.provider_message_id
    JOIN ops.inbound_events newer ON newer.tenant_id=event.tenant_id
      AND newer.provider=event.provider AND newer.provider_account_id=event.provider_account_id
      AND newer.receipt_sequence>event.receipt_sequence
      AND newer.status IN ('received','processing','failed')
      AND (newer.status='processing' OR newer.attempts<newer.max_attempts)
      AND newer.event_type IN ('whatsapp.message.text','whatsapp.message.image',
        'whatsapp.message.document','whatsapp.message.location','whatsapp.message.audio',
        'whatsapp.message.video','whatsapp.message.interactive')
      AND newer.payload->>'providerMessageId'<>m.provider_message_id
      AND regexp_replace(newer.payload->>'from','[^0-9]','','g')
        =regexp_replace(origin.sender_address,'[^0-9]','','g')
    WHERE m.tenant_id=platform.current_tenant_id() AND m.id=p_trigger
  ) THEN RETURN NULL; END IF;

 SELECT jsonb_build_object('tenantId',m.tenant_id,'modelConfigurationId',m.id,
   'credentialId',cr.id,'provider',m.provider,'kind',cr.kind,'algorithm',cr.algorithm,
   'keyVersion',cr.key_version,'ciphertext',encode(cr.ciphertext,'hex'),
   'nonce',encode(cr.nonce,'hex')) INTO envelope
 FROM agents.model_configurations m JOIN platform.credential_records cr
   ON cr.tenant_id=m.tenant_id AND cr.id=m.credential_id
 WHERE m.tenant_id=platform.current_tenant_id() AND m.id=p_configuration AND m.is_enabled
   AND m.credential_id=p_credential AND m.provider IN ('openai','gemini')
   AND cr.kind='llm_api_key_v2' AND cr.algorithm='aes-256-gcm:model-provider:v2'
   AND cr.key_version IS NOT NULL AND cr.key_version<>'env:v1'
   AND cr.ciphertext IS NOT NULL AND octet_length(cr.ciphertext) BETWEEN 17 AND 10000
   AND cr.nonce IS NOT NULL AND octet_length(cr.nonce)=12;
 RETURN envelope;
END $$;
"""


def upgrade() -> None:
    op.execute(SchemaDDL(SQL.replace("%", "%%")))
    op.execute("REVOKE ALL ON FUNCTION " + SIGNATURE + " FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION " + SIGNATURE + " TO platform_messaging")


def downgrade() -> None:
    op.execute("DROP FUNCTION " + SIGNATURE)
