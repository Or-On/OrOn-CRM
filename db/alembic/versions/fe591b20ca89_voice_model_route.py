"""Project and reserve explicit voice model routes under an active pinned call."""

# ruff: noqa: E501 -- reviewed SQL
from alembic import op

revision = "fe591b20ca89"
down_revision = "fd480a1fb978"
branch_labels = None
depends_on = None

SIGNATURE = "platform.voice_model_route(uuid,boolean,jsonb)"
SQL = """
CREATE FUNCTION platform.voice_model_route(p_session uuid,p_reserve boolean,p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  call public.sessions%ROWTYPE;
  control public.voice_session_controls%ROWTYPE;
  agent agents.agent_profile_versions%ROWTYPE;
  configuration agents.model_configurations%ROWTYPE;
  credential platform.credential_records%ROWTYPE;
  pinned text;
  result jsonb;
  reserved bigint;
BEGIN
  IF NOT platform.current_tenant_active() OR NOT platform.current_tenant_feature_enabled('voice')
    OR NOT platform.current_tenant_feature_enabled('agents') THEN RETURN NULL; END IF;
  SELECT * INTO call FROM public.sessions s WHERE s.tenant_id=platform.current_tenant_id()
    AND s.session_id=p_session AND s.status='started' AND s.ended_at IS NULL AND s.provider='livekit'
    FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO control FROM public.voice_session_controls c
    WHERE c.tenant_id=call.tenant_id AND c.session_id=call.session_id FOR SHARE;
  IF FOUND AND (control.desired_mode<>'ai' OR (control.requested_by_user_id IS NOT NULL
    AND NOT platform.voice_control_actor_allowed(control.requested_by_user_id,true))) THEN RETURN NULL; END IF;
  SELECT e.payload->>'agent_version_id' INTO pinned FROM public.session_events e
    WHERE e.tenant_id=call.tenant_id AND e.session_id=call.session_id AND e.event_type='voice.agent.binding.v1'
    ORDER BY e.sequence LIMIT 1;
  SELECT v.* INTO agent FROM agents.agent_profile_versions v
    JOIN agents.agent_profiles profile ON profile.tenant_id=v.tenant_id AND profile.id=v.agent_profile_id
    WHERE v.tenant_id=call.tenant_id AND v.id::text=pinned AND v.published_at IS NOT NULL
      AND v.validation_status='valid' AND 'voice'=ANY(v.channel_capabilities) AND profile.archived_at IS NULL
    FOR SHARE OF v,profile;
  IF NOT FOUND OR agent.model_configuration_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO configuration FROM agents.model_configurations m
    WHERE m.tenant_id=call.tenant_id AND m.id=agent.model_configuration_id AND m.is_enabled
      AND m.provider IN ('gemini','openai') FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO credential FROM platform.credential_records c
    WHERE c.tenant_id=call.tenant_id AND c.id=configuration.credential_id
      AND c.kind='llm_api_key_v2' AND c.algorithm='aes-256-gcm:model-provider:v2'
      AND c.key_version IS NOT NULL AND c.key_version<>'env:v1'
      AND octet_length(c.ciphertext) BETWEEN 17 AND 10000 AND octet_length(c.nonce)=12 FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  result:=jsonb_build_object('agentVersionId',agent.id,
    'configuration',jsonb_build_object('id',configuration.id,'tenantId',configuration.tenant_id,
      'provider',configuration.provider,'model',configuration.model,'settings',configuration.settings,
      'dailyRequestLimit',configuration.daily_request_limit),
    'credential',jsonb_build_object('tenantId',credential.tenant_id,'modelConfigurationId',configuration.id,
      'credentialId',credential.id,'provider',configuration.provider,'kind',credential.kind,
      'algorithm',credential.algorithm,'keyVersion',credential.key_version,
      'ciphertext',encode(credential.ciphertext,'hex'),'nonce',encode(credential.nonce,'hex')));
  IF p_reserve THEN
    IF p_expected IS NULL OR result IS DISTINCT FROM p_expected THEN RETURN NULL; END IF;
    IF configuration.daily_request_limit IS NOT NULL THEN
      INSERT INTO agents.model_daily_reservations AS r(tenant_id,model_configuration_id,utc_day,reserved_attempts)
      VALUES(call.tenant_id,configuration.id,(clock_timestamp() AT TIME ZONE 'UTC')::date,1)
      ON CONFLICT(tenant_id,model_configuration_id,utc_day) DO UPDATE
        SET reserved_attempts=r.reserved_attempts+1,updated_at=clock_timestamp()
        WHERE r.reserved_attempts<configuration.daily_request_limit RETURNING reserved_attempts INTO reserved;
      IF reserved IS NULL THEN RETURN NULL; END IF;
    END IF;
  END IF;
  -- Recheck after any quota-counter lock wait; feature revocation must fail closed.
  IF NOT platform.current_tenant_active() OR NOT platform.current_tenant_feature_enabled('voice')
    OR NOT platform.current_tenant_feature_enabled('agents') THEN RETURN NULL; END IF;
  RETURN result;
END $$;
"""


def upgrade() -> None:
    op.execute(SQL)
    op.execute("REVOKE ALL ON FUNCTION " + SIGNATURE + " FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION " + SIGNATURE + " TO platform_voice")


def downgrade() -> None:
    op.execute("DROP FUNCTION " + SIGNATURE)
