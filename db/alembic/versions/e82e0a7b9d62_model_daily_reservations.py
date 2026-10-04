"""Reserve explicit configured model attempts under fresh canonical authority."""

from alembic import op

revision = "e82e0a7b9d62"
down_revision = "e71df96a8c51"
branch_labels = None
depends_on = None

TABLE_SQL = """
CREATE TABLE agents.model_daily_reservations (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  model_configuration_id uuid NOT NULL,
  utc_day date NOT NULL,
  reserved_attempts bigint NOT NULL CHECK(reserved_attempts>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,model_configuration_id,utc_day),
  FOREIGN KEY(tenant_id,model_configuration_id)
    REFERENCES agents.model_configurations(tenant_id,id) ON DELETE RESTRICT
)
"""

FUNCTION_SQL = """
CREATE FUNCTION agents.reserve_messaging_model_attempt(
  p_job uuid,p_worker text,p_token uuid,p_agent uuid,p_configuration uuid,
  p_actor uuid,p_epoch bigint,p_trigger uuid,p_expected jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  job ops.jobs%ROWTYPE;
  conversation messaging.conversations%ROWTYPE;
  configuration agents.model_configurations%ROWTYPE;
  channel messaging.channels%ROWTYPE;
  latest_trigger uuid;
  deadline timestamptz;
  reservation_day date;
  inserted bigint;
BEGIN
  IF platform.current_tenant_id() IS NULL OR p_worker IS NULL
    OR length(p_worker) NOT BETWEEN 1 AND 200 THEN RETURN false; END IF;
  SELECT j.* INTO job FROM ops.jobs j
    WHERE j.tenant_id=platform.current_tenant_id() AND j.id=p_job
      AND j.queue='messaging' AND j.job_type='whatsapp.ai.reply'
      AND j.status='running' AND j.locked_by=p_worker AND j.claim_token=p_token
      AND j.lease_expires_at>clock_timestamp() AND j.admitted_agent_version_id=p_agent
      AND j.reference_type='conversation'
    FOR UPDATE OF j;
  IF NOT FOUND THEN RETURN false; END IF;
  deadline:=job.lease_expires_at;
  SELECT c.* INTO conversation FROM messaging.conversations c
    JOIN agents.agent_profile_versions a ON a.id=c.ai_agent_profile_version_id
      AND a.tenant_id=c.tenant_id AND a.id=p_agent
    JOIN agents.agent_profiles profile ON profile.id=a.agent_profile_id
      AND profile.tenant_id=a.tenant_id AND profile.archived_at IS NULL
    WHERE c.tenant_id=platform.current_tenant_id() AND c.id=job.reference_id
      AND job.payload->>'conversationId'=c.id::text
      AND job.payload->>'triggerMessageId'=p_trigger::text
      AND c.ownership_mode='ai' AND c.removed_from_inbox_at IS NULL
      AND c.ownership_epoch=p_epoch AND c.ai_enabled_by_user_id=p_actor
      AND a.published_at IS NOT NULL AND a.validation_status='valid'
      AND 'whatsapp'=ANY(a.channel_capabilities) AND a.model_configuration_id=p_configuration
      AND platform.messaging_ai_actor_authorized(p_actor)
    FOR UPDATE OF c;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT c.* INTO channel FROM messaging.channels c
    WHERE c.tenant_id=platform.current_tenant_id() AND c.id=conversation.channel_id
      AND c.kind='whatsapp' AND c.status='active' AND c.provider IN ('meta','simulator')
    FOR SHARE OF c;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT m.* INTO configuration FROM agents.model_configurations m
    WHERE m.tenant_id=platform.current_tenant_id() AND m.id=p_configuration AND m.is_enabled
    FOR SHARE OF m;
  IF NOT FOUND THEN RETURN false; END IF;
  IF jsonb_build_object('id',configuration.id,'tenantId',configuration.tenant_id,
      'provider',configuration.provider,'model',configuration.model,
      'credentialId',configuration.credential_id,'enabled',configuration.is_enabled,
      'settings',configuration.settings,'dailyRequestLimit',configuration.daily_request_limit)
      IS DISTINCT FROM p_expected THEN RETURN false; END IF;
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
  ) THEN RETURN false; END IF;
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
  ) THEN RETURN false; END IF;
  IF deadline<=clock_timestamp() THEN RETURN false; END IF;
  -- NULL is explicitly unlimited: no limit or fictitious reservation is imposed.
  IF configuration.daily_request_limit IS NULL THEN RETURN true; END IF;
  reservation_day:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
  BEGIN
    INSERT INTO agents.model_daily_reservations AS r
    (tenant_id,model_configuration_id,utc_day,reserved_attempts,updated_at)
    VALUES(platform.current_tenant_id(),configuration.id,reservation_day,1,clock_timestamp())
    ON CONFLICT(tenant_id,model_configuration_id,utc_day) DO UPDATE
      SET reserved_attempts=r.reserved_attempts+1,updated_at=clock_timestamp()
      WHERE r.reserved_attempts<configuration.daily_request_limit
      RETURNING reserved_attempts INTO inserted;
    -- Counter contention can outlive authority. Re-read unlocked trust rows.
    IF deadline<=clock_timestamp() OR NOT platform.messaging_ai_actor_authorized(p_actor)
      OR NOT EXISTS (
        SELECT 1 FROM agents.agent_profile_versions a
        JOIN agents.agent_profiles profile ON profile.tenant_id=a.tenant_id
          AND profile.id=a.agent_profile_id AND profile.archived_at IS NULL
        WHERE a.tenant_id=platform.current_tenant_id() AND a.id=p_agent
          AND a.published_at IS NOT NULL AND a.validation_status='valid'
          AND a.model_configuration_id=p_configuration
      ) THEN
      RAISE EXCEPTION 'model reservation authority changed' USING ERRCODE='P0004';
    END IF;
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
    ) OR EXISTS (
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
    ) THEN
      RAISE EXCEPTION 'model reservation trigger changed' USING ERRCODE='P0004';
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0004' THEN RETURN false;
  END;
  RETURN inserted IS NOT NULL;
END $$
"""


def upgrade() -> None:
    op.execute(TABLE_SQL)
    op.execute("ALTER TABLE agents.model_daily_reservations ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE agents.model_daily_reservations FORCE ROW LEVEL SECURITY")
    op.execute("""
      CREATE POLICY model_daily_reservations_isolation ON agents.model_daily_reservations
      USING(tenant_id=platform.current_tenant_id())
      WITH CHECK(tenant_id=platform.current_tenant_id())
    """)
    op.execute(FUNCTION_SQL)
    op.execute("""
      REVOKE ALL ON FUNCTION agents.reserve_messaging_model_attempt(
        uuid,text,uuid,uuid,uuid,uuid,bigint,uuid,jsonb) FROM PUBLIC
    """)
    op.execute("""
      GRANT EXECUTE ON FUNCTION agents.reserve_messaging_model_attempt(
        uuid,text,uuid,uuid,uuid,uuid,bigint,uuid,jsonb) TO platform_messaging
    """)


def downgrade() -> None:
    op.execute("""
      DROP FUNCTION agents.reserve_messaging_model_attempt(
        uuid,text,uuid,uuid,uuid,uuid,bigint,uuid,jsonb)
    """)
    op.execute("DROP TABLE agents.model_daily_reservations")
