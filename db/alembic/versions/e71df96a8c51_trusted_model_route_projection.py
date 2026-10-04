"""narrow authorized published-agent model and channel metadata projection"""

from alembic import op

revision = "e71df96a8c51"
down_revision = "e60cf8597b40"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE FUNCTION platform.current_published_model_route(
        p_version uuid,p_actor uuid,p_channel uuid)
      RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT jsonb_build_object(
          'binding',jsonb_build_object('tenantId',v.tenant_id,'agentVersionId',v.id,
            'published',true,'validationStatus',v.validation_status,'authorized',true,
            'modelConfigurationId',v.model_configuration_id),
          'configuration',CASE WHEN m.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id',m.id,'tenantId',m.tenant_id,'provider',m.provider,'model',m.model,
            'credentialId',m.credential_id,'enabled',m.is_enabled,'settings',m.settings,
            'dailyRequestLimit',m.daily_request_limit) END,
          'channel',jsonb_build_object('tenantId',c.tenant_id,'channelId',c.id,
            'kind',c.kind,'provider',c.provider,'status',c.status,
            'providerAccountId',c.provider_account_id,'credentialId',c.credential_id),
          'modelCredential',CASE WHEN mc.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id',mc.id,'tenantId',mc.tenant_id,'kind',mc.kind,
            'envelopePresent',mc.ciphertext IS NOT NULL,'keyVersion',mc.key_version) END,
          'channelCredential',CASE WHEN cc.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id',cc.id,'tenantId',cc.tenant_id,'kind',cc.kind,
            'envelopePresent',cc.ciphertext IS NOT NULL,'keyVersion',cc.key_version) END)
        FROM agents.agent_profile_versions v
        JOIN agents.agent_profiles p ON p.tenant_id=v.tenant_id AND p.id=v.agent_profile_id
          AND p.archived_at IS NULL
        JOIN messaging.channels c ON c.tenant_id=v.tenant_id AND c.id=p_channel
          AND c.kind='whatsapp' AND c.status='active'
        LEFT JOIN agents.model_configurations m
          ON m.tenant_id=v.tenant_id AND m.id=v.model_configuration_id
        LEFT JOIN platform.credential_records mc
          ON mc.tenant_id=m.tenant_id AND mc.id=m.credential_id
        LEFT JOIN platform.credential_records cc
          ON cc.tenant_id=c.tenant_id AND cc.id=c.credential_id
        WHERE v.tenant_id=platform.current_tenant_id() AND v.id=p_version
          AND v.published_at IS NOT NULL AND v.validation_status='valid'
          AND 'whatsapp'=ANY(v.channel_capabilities)
          AND platform.messaging_ai_actor_authorized(p_actor)
      $$
    """)
    op.execute(
        "REVOKE ALL ON FUNCTION platform.current_published_model_route(uuid,uuid,uuid) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.current_published_model_route(uuid,uuid,uuid) "
        "TO platform_messaging"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.current_published_model_route(uuid,uuid,uuid)")
