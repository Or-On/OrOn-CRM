"""Fence field intake inference to its tenant configuration and physical attempt quota."""

# ruff: noqa: E501 -- reviewed SQL
from alembic import op

revision = "a18c4e53fd02"
down_revision = "a07b3d42ec91"
branch_labels = None
depends_on = None
SIGNATURE = "platform.field_intake_model_route(uuid,text,uuid,boolean,jsonb)"
SQL = """
CREATE FUNCTION platform.field_intake_model_route(p_job uuid,p_worker text,p_claim uuid,p_reserve boolean,p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  job ops.jobs%ROWTYPE;
  conversation messaging.conversations%ROWTYPE;
  agent agents.agent_profile_versions%ROWTYPE;
  configuration agents.model_configurations%ROWTYPE;
  credential platform.credential_records%ROWTYPE;
  result jsonb;
  reserved bigint;
BEGIN
  IF NOT platform.current_tenant_active() OR NOT platform.current_tenant_feature_enabled('whatsapp')
    OR NOT platform.current_tenant_feature_enabled('field_service') THEN RETURN NULL; END IF;
  SELECT * INTO job FROM ops.jobs j WHERE j.tenant_id=platform.current_tenant_id() AND j.id=p_job
    AND j.queue='messaging' AND j.job_type='field_service.intake.extract' AND j.status='running'
    AND j.locked_by=p_worker AND j.claim_token=p_claim AND j.lease_expires_at>clock_timestamp()
    AND j.reference_type='message' AND j.payload->>'triggerMessageId'=j.reference_id::text FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT c.* INTO conversation FROM messaging.conversations c
    JOIN messaging.messages m ON m.tenant_id=c.tenant_id AND m.conversation_id=c.id
    JOIN messaging.channels ch ON ch.tenant_id=c.tenant_id AND ch.id=c.channel_id
    JOIN crm.contacts contact ON contact.tenant_id=c.tenant_id AND contact.id=c.contact_id
    WHERE c.tenant_id=job.tenant_id AND m.id=job.reference_id AND m.direction='inbound' AND m.status='received'
      AND job.payload->>'conversationId'=c.id::text AND job.payload->>'contactId'=c.contact_id::text
      AND c.ownership_mode='ai' AND c.removed_from_inbox_at IS NULL
      AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
      AND ch.kind='whatsapp' AND ch.status='active' AND ch.provider IN ('meta','simulator')
      AND contact.lifecycle_status='active'
      AND (ch.provider='simulator' OR (contact.whatsapp_consent='granted' AND contact.whatsapp_opted_out_at IS NULL))
      AND EXISTS(SELECT 1 FROM service.tenant_configuration config WHERE config.tenant_id=c.tenant_id
        AND config.enabled AND config.whatsapp_intake_enabled)
    FOR UPDATE OF c;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM platform.authorize_machine_tool(p_job,p_worker,p_claim,'service.intake');
  SELECT a.* INTO agent FROM agents.agent_profile_versions a
    JOIN agents.agent_profiles p ON p.tenant_id=a.tenant_id AND p.id=a.agent_profile_id
    WHERE a.tenant_id=job.tenant_id AND a.id=conversation.ai_agent_profile_version_id
      AND a.published_at IS NOT NULL AND a.validation_status='valid' AND p.archived_at IS NULL
      AND 'whatsapp'=ANY(a.channel_capabilities) AND a.tool_permissions ? 'service.intake' FOR SHARE OF a,p;
  IF NOT FOUND THEN RETURN NULL; END IF;
  result:=jsonb_build_object('tenantId',job.tenant_id,'agentVersionId',agent.id,
    'ownershipEpoch',conversation.ownership_epoch::text,'actorUserId',conversation.ai_enabled_by_user_id,
    'configuration',NULL,'credential',NULL);
  IF agent.model_configuration_id IS NOT NULL THEN
    SELECT * INTO configuration FROM agents.model_configurations m
      WHERE m.tenant_id=job.tenant_id AND m.id=agent.model_configuration_id AND m.is_enabled
        AND m.provider IN ('gemini','openai') FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO credential FROM platform.credential_records c
      WHERE c.tenant_id=job.tenant_id AND c.id=configuration.credential_id
        AND c.kind='llm_api_key_v2' AND c.algorithm='aes-256-gcm:model-provider:v2'
        AND c.key_version IS NOT NULL AND c.key_version<>'env:v1'
        AND octet_length(c.ciphertext) BETWEEN 17 AND 10000 AND octet_length(c.nonce)=12 FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    result:=result || jsonb_build_object('configuration',jsonb_build_object('id',configuration.id,
      'tenantId',configuration.tenant_id,'provider',configuration.provider,'model',configuration.model,
      'credentialId',credential.id,'enabled',configuration.is_enabled,'settings',configuration.settings,
      'dailyRequestLimit',configuration.daily_request_limit),
      'credential',jsonb_build_object('tenantId',credential.tenant_id,'modelConfigurationId',configuration.id,
        'credentialId',credential.id,'provider',configuration.provider,'kind',credential.kind,
        'algorithm',credential.algorithm,'keyVersion',credential.key_version,
        'ciphertext',encode(credential.ciphertext,'hex'),'nonce',encode(credential.nonce,'hex')));
  END IF;
  IF p_reserve THEN
    IF p_expected IS NULL OR result IS DISTINCT FROM p_expected THEN RETURN NULL; END IF;
    IF configuration.daily_request_limit IS NOT NULL THEN
      INSERT INTO agents.model_daily_reservations AS r(tenant_id,model_configuration_id,utc_day,reserved_attempts)
      VALUES(job.tenant_id,configuration.id,(clock_timestamp() AT TIME ZONE 'UTC')::date,1)
      ON CONFLICT(tenant_id,model_configuration_id,utc_day) DO UPDATE
        SET reserved_attempts=r.reserved_attempts+1,updated_at=clock_timestamp()
        WHERE r.reserved_attempts<configuration.daily_request_limit RETURNING reserved_attempts INTO reserved;
      IF reserved IS NULL THEN RETURN NULL; END IF;
    END IF;
  END IF;
  IF job.lease_expires_at<=clock_timestamp() OR NOT platform.messaging_ai_actor_authorized(conversation.ai_enabled_by_user_id)
    OR NOT platform.current_tenant_active() OR NOT platform.current_tenant_feature_enabled('whatsapp')
    OR NOT platform.current_tenant_feature_enabled('field_service') THEN RETURN NULL; END IF;
  PERFORM platform.authorize_machine_tool(p_job,p_worker,p_claim,'service.intake');
  RETURN result;
END $$;
"""


def upgrade() -> None:
    op.execute(SQL)
    op.execute("REVOKE ALL ON FUNCTION " + SIGNATURE + " FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION " + SIGNATURE + " TO platform_messaging")


def downgrade() -> None:
    op.execute("DROP FUNCTION " + SIGNATURE)
