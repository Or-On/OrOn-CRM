"""Atomically admit the current claimed reply to an eligible business Agent session."""

from alembic import op

revision = "f0a862f375ea"
down_revision = "ef9751e264d9"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
    CREATE TABLE agents.messaging_session_admissions(
      job_id uuid PRIMARY KEY REFERENCES ops.jobs(id) ON DELETE RESTRICT,
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
      agent_version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id) ON DELETE
      RESTRICT,
      admitted_at timestamptz NOT NULL DEFAULT clock_timestamp())
    """)
    op.execute("ALTER TABLE agents.messaging_session_admissions ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE agents.messaging_session_admissions FORCE ROW LEVEL SECURITY")
    op.execute("""
      CREATE POLICY session_admission_isolation ON agents.messaging_session_admissions
      USING(tenant_id=platform.current_tenant_id()) WITH
      CHECK(tenant_id=platform.current_tenant_id())
    """)
    # No runtime table grants: only the narrow current-claim capability writes.
    op.execute("""
    CREATE FUNCTION platform.admit_messaging_session_agent(
      p_job uuid,p_worker text,p_claim uuid,p_idle_hours integer DEFAULT 12)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE j ops.jobs%ROWTYPE; c messaging.conversations%ROWTYPE;
      s agents.messaging_memory_sessions%ROWTYPE;
      a agents.agent_profile_versions%ROWTYPE; selected uuid; trigger_id uuid; prior uuid;
      protected_flows uuid[];
    BEGIN
      IF p_idle_hours IS NULL OR p_idle_hours NOT BETWEEN 1 AND 168 THEN
        RAISE EXCEPTION 'invalid session interval' USING ERRCODE='22023';
      END IF;
      SELECT * INTO j FROM ops.jobs WHERE id=p_job
        AND tenant_id=platform.current_tenant_id() AND queue='messaging'
        AND job_type='whatsapp.ai.reply' AND reference_type='conversation'
        AND status='running' AND locked_by=p_worker AND claim_token=p_claim
        AND lease_expires_at>clock_timestamp() FOR UPDATE;
      IF j.id IS NULL THEN
        RAISE EXCEPTION 'session claim denied' USING ERRCODE='42501';
      END IF;
      SELECT conversation.* INTO c FROM messaging.conversations conversation
        JOIN public.tenants t ON t.id=conversation.tenant_id AND t.status='active'
        JOIN messaging.channels channel ON channel.id=conversation.channel_id
          AND channel.tenant_id=conversation.tenant_id AND channel.status='active'
          AND channel.kind='whatsapp' AND channel.provider IN('meta','simulator')
        JOIN crm.contacts contact ON contact.id=conversation.contact_id
          AND contact.tenant_id=conversation.tenant_id
        WHERE conversation.id=j.reference_id AND conversation.tenant_id=j.tenant_id
          AND conversation.ownership_mode='ai' AND conversation.removed_from_inbox_at IS NULL
          AND platform.messaging_ai_actor_authorized(conversation.ai_enabled_by_user_id)
        FOR UPDATE OF conversation;
      IF c.id IS NULL THEN
        RAISE EXCEPTION 'session ownership denied' USING ERRCODE='42501';
      END IF;
      -- Trigger is stored by ingestion, not supplied by the model/browser.
      SELECT m.id INTO trigger_id FROM messaging.messages m
        JOIN messaging.channels channel ON channel.id=c.channel_id AND channel.tenant_id=m.tenant_id
        LEFT JOIN ops.inbound_events event ON event.tenant_id=m.tenant_id AND
      event.provider=m.provider
          AND event.provider_account_id=channel.provider_account_id
          AND event.payload->>'providerMessageId'=m.provider_message_id
        WHERE m.conversation_id=c.id AND m.tenant_id=c.tenant_id
          AND m.direction='inbound' AND m.sender_type='contact' AND m.content_type<>'event'
        ORDER BY COALESCE(event.received_at,m.created_at) DESC,event.receipt_sequence DESC
      NULLS LAST,
          m.created_at DESC,m.updated_at DESC,m.id DESC LIMIT 1;
      IF trigger_id IS NULL OR j.payload->>'triggerMessageId' IS DISTINCT FROM trigger_id::text THEN
        RAISE EXCEPTION 'session trigger superseded' USING ERRCODE='42501';
      END IF;
      SELECT version.* INTO a FROM agents.agent_profile_versions version
        JOIN agents.agent_profiles profile ON profile.id=version.agent_profile_id
          AND profile.tenant_id=version.tenant_id AND profile.archived_at IS NULL
        WHERE version.id=c.ai_agent_profile_version_id AND version.tenant_id=c.tenant_id;
      IF a.id IS NULL THEN
        RAISE EXCEPTION 'session business profile unavailable' USING ERRCODE='42501';
      END IF;
      IF NOT EXISTS(SELECT 1 FROM platform.tenant_remediation_flags
        WHERE tenant_id=c.tenant_id AND flag_key='session_memory' AND enabled) THEN
        RETURN c.ai_agent_profile_version_id;
      END IF;
      SELECT array_agg(flow.id) INTO protected_flows FROM automation.flow_versions flow
        JOIN automation.flow_definitions definition ON definition.id=flow.flow_definition_id
          AND definition.tenant_id=flow.tenant_id AND definition.archived_at IS NULL
        WHERE flow.tenant_id=c.tenant_id AND flow.agent_profile_version_id=a.id
          AND flow.published_at IS NOT NULL AND flow.validation_status='valid'
          AND 'whatsapp'=ANY(definition.channel_capabilities)
          AND platform.approved_flow_for_channel(flow.id,a.id,'whatsapp');
      SELECT admission.agent_version_id INTO prior FROM agents.messaging_session_admissions
      admission
        WHERE admission.job_id=j.id AND admission.tenant_id=j.tenant_id;
      IF prior IS NOT NULL THEN
        IF prior<>c.ai_agent_profile_version_id OR prior IS DISTINCT FROM
      j.admitted_agent_version_id THEN
          RAISE EXCEPTION 'admitted session binding changed' USING ERRCODE='42501';
        END IF;
        selected:=prior;
      ELSE
        -- Fair queue capacity admission may already set the legacy version
        -- column. It is not proof of session selection. Never rotate a job
        -- after a recorded physical provider attempt, even without a marker.
        IF EXISTS(SELECT 1 FROM agents.model_attempts attempt WHERE attempt.job_id=j.id) THEN
          RAISE EXCEPTION 'unmarked billed session cannot rotate' USING ERRCODE='42501';
        END IF;
        SELECT session.* INTO s FROM agents.messaging_memory_sessions session
          WHERE session.tenant_id=c.tenant_id AND session.conversation_id=c.id
            AND session.last_activity_at>clock_timestamp()-make_interval(hours=>p_idle_hours)
          ORDER BY session.last_activity_at DESC,session.id DESC LIMIT 1;
        IF s.id IS NOT NULL THEN
          IF s.agent_version_id<>c.ai_agent_profile_version_id THEN
            RAISE EXCEPTION 'active session binding changed' USING ERRCODE='42501';
          END IF;
          selected:=s.agent_version_id;
        ELSE
          SELECT version.id INTO selected FROM agents.agent_profile_versions version
            WHERE version.tenant_id=c.tenant_id AND version.agent_profile_id=a.agent_profile_id
              AND version.published_at IS NOT NULL AND version.validation_status='valid'
              AND 'whatsapp'=ANY(version.channel_capabilities)
              AND (NOT platform.current_tenant_requires_approved_routing()
                OR platform.approved_agent_for_channel(version.id,'whatsapp'))
              -- Every currently authorized business Flow must retain a
              -- compatible published revision. Never silently drop an
              -- explicit Flow when refreshing its Agent's session version.
              AND NOT EXISTS(
                SELECT 1 FROM automation.flow_versions old_flow
                JOIN automation.flow_definitions definition
                  ON definition.id=old_flow.flow_definition_id
                  AND definition.tenant_id=old_flow.tenant_id
                  AND definition.archived_at IS NULL
                WHERE old_flow.tenant_id=c.tenant_id
                  AND old_flow.agent_profile_version_id=a.id
                  AND old_flow.published_at IS NOT NULL AND old_flow.validation_status='valid'
                  AND 'whatsapp'=ANY(definition.channel_capabilities)
                  AND platform.approved_flow_for_channel(old_flow.id,a.id,'whatsapp')
                  AND NOT EXISTS(
                    SELECT 1 FROM automation.flow_versions new_flow
                    WHERE new_flow.tenant_id=old_flow.tenant_id
                      AND new_flow.flow_definition_id=old_flow.flow_definition_id
                      AND new_flow.agent_profile_version_id=version.id
                      AND new_flow.published_at IS NOT NULL AND new_flow.validation_status='valid'
                      AND platform.approved_flow_for_channel(new_flow.id,version.id,'whatsapp')))
            ORDER BY version.version DESC,version.published_at DESC,version.id DESC LIMIT 1;
        END IF;
      END IF;
      IF selected IS NULL OR NOT EXISTS(SELECT 1 FROM agents.agent_profile_versions version
        WHERE version.id=selected AND version.tenant_id=c.tenant_id
          AND version.agent_profile_id=a.agent_profile_id AND version.published_at IS NOT NULL
          AND version.validation_status='valid' AND 'whatsapp'=ANY(version.channel_capabilities)
          AND (NOT platform.current_tenant_requires_approved_routing()
            OR platform.approved_agent_for_channel(version.id,'whatsapp'))) THEN
        RAISE EXCEPTION 'session version revoked or unavailable' USING ERRCODE='42501';
      END IF;
      -- Keep canonical eligibility stable until the caller's contract/knowledge
      -- projection commits. A concurrent revocation waits, then subsequent
      -- physical provider attempts still re-read their own fresh authority.
      PERFORM 1 FROM agents.agent_profiles profile WHERE profile.id=a.agent_profile_id FOR SHARE;
      PERFORM 1 FROM agents.agent_profile_versions version WHERE version.id=selected FOR SHARE;
      PERFORM 1 FROM agents.model_configurations configuration
        JOIN agents.agent_profile_versions version ON
      version.model_configuration_id=configuration.id
          AND version.tenant_id=configuration.tenant_id
        WHERE version.id=selected FOR SHARE OF configuration;
      PERFORM 1 FROM platform.credential_records credential
        JOIN agents.model_configurations configuration ON configuration.credential_id=credential.id
          AND configuration.tenant_id=credential.tenant_id
        JOIN agents.agent_profile_versions version ON
      version.model_configuration_id=configuration.id
          AND version.tenant_id=configuration.tenant_id
        WHERE version.id=selected FOR SHARE OF credential;
      PERFORM 1 FROM public.tenants WHERE id=c.tenant_id FOR SHARE;
      PERFORM 1 FROM messaging.channels WHERE id=c.channel_id FOR SHARE;
      PERFORM 1 FROM crm.contacts WHERE id=c.contact_id FOR SHARE;
      PERFORM 1 FROM public.users WHERE id=c.ai_enabled_by_user_id FOR SHARE;
      PERFORM 1 FROM public.memberships WHERE tenant_id=c.tenant_id
        AND user_id=c.ai_enabled_by_user_id FOR SHARE;
      PERFORM 1 FROM platform.tenant_remediation_flags WHERE tenant_id=c.tenant_id FOR SHARE;
      PERFORM 1 FROM platform.tenant_configuration_releases
        WHERE tenant_id=c.tenant_id FOR SHARE;
      PERFORM 1 FROM automation.tenant_processes WHERE tenant_id=c.tenant_id FOR SHARE;
      PERFORM 1 FROM automation.flow_definitions definition
        JOIN automation.flow_versions flow ON flow.flow_definition_id=definition.id
          AND flow.tenant_id=definition.tenant_id
        WHERE flow.tenant_id=c.tenant_id AND flow.agent_profile_version_id IN(a.id,selected)
        FOR SHARE OF definition,flow;
      -- Every earlier lookup may precede a blocked lock acquisition. Re-read
      -- canonical predicates after acquiring locks; never commit an old snapshot.
      IF NOT EXISTS(SELECT 1 FROM public.tenants tenant
        JOIN messaging.channels channel ON channel.tenant_id=tenant.id AND channel.id=c.channel_id
        JOIN crm.contacts contact ON contact.tenant_id=tenant.id AND contact.id=c.contact_id
        JOIN agents.agent_profiles profile ON profile.tenant_id=tenant.id
          AND profile.id=a.agent_profile_id AND profile.archived_at IS NULL
        JOIN agents.agent_profile_versions version ON version.tenant_id=tenant.id
          AND version.agent_profile_id=profile.id AND version.id=selected
        WHERE tenant.id=c.tenant_id AND tenant.status='active' AND channel.status='active'
          AND version.published_at IS NOT NULL AND version.validation_status='valid'
          AND 'whatsapp'=ANY(version.channel_capabilities)
          AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
          AND (NOT platform.current_tenant_requires_approved_routing()
            OR platform.approved_agent_for_channel(version.id,'whatsapp')))
        OR NOT EXISTS(SELECT 1 FROM platform.tenant_remediation_flags
          WHERE tenant_id=c.tenant_id AND flag_key='session_memory' AND enabled) THEN
        RAISE EXCEPTION 'session eligibility revoked after lock' USING ERRCODE='42501';
      END IF;
      IF EXISTS(SELECT 1 FROM unnest(protected_flows) protected(id)
        WHERE NOT platform.approved_flow_for_channel(protected.id,a.id,'whatsapp')
          OR NOT EXISTS(SELECT 1 FROM automation.flow_versions flow
            JOIN automation.flow_definitions definition ON definition.id=flow.flow_definition_id
              AND definition.tenant_id=flow.tenant_id AND definition.archived_at IS NULL
            WHERE flow.id=protected.id AND flow.tenant_id=c.tenant_id
              AND flow.published_at IS NOT NULL AND flow.validation_status='valid')) THEN
        RAISE EXCEPTION 'protected session Flow revoked after lock' USING ERRCODE='42501';
      END IF;
      IF NOT (NOT EXISTS(
                SELECT 1 FROM automation.flow_versions old_flow
                JOIN automation.flow_definitions definition
                  ON definition.id=old_flow.flow_definition_id
                  AND definition.tenant_id=old_flow.tenant_id
                  AND definition.archived_at IS NULL
                WHERE old_flow.tenant_id=c.tenant_id
                  AND old_flow.agent_profile_version_id=a.id
                  AND old_flow.published_at IS NOT NULL AND old_flow.validation_status='valid'
                  AND 'whatsapp'=ANY(definition.channel_capabilities)
                  AND platform.approved_flow_for_channel(old_flow.id,a.id,'whatsapp')
                  AND NOT EXISTS(
                    SELECT 1 FROM automation.flow_versions new_flow
                    WHERE new_flow.tenant_id=old_flow.tenant_id
                      AND new_flow.flow_definition_id=old_flow.flow_definition_id
                      AND new_flow.agent_profile_version_id=selected
                      AND new_flow.published_at IS NOT NULL AND new_flow.validation_status='valid'
                      AND
      platform.approved_flow_for_channel(new_flow.id,selected,'whatsapp')))) THEN
        RAISE EXCEPTION 'session Flow binding revoked' USING ERRCODE='42501';
      END IF;
      IF EXISTS(SELECT 1 FROM agents.agent_profile_versions version
        LEFT JOIN agents.model_configurations configuration
          ON configuration.id=version.model_configuration_id AND
      configuration.tenant_id=version.tenant_id
        LEFT JOIN platform.credential_records credential
          ON credential.id=configuration.credential_id AND
      credential.tenant_id=configuration.tenant_id
        WHERE version.id=selected AND version.model_configuration_id IS NOT NULL
          AND (configuration.id IS NULL OR NOT configuration.is_enabled
            OR configuration.credential_id IS NULL OR credential.id IS NULL
            OR credential.ciphertext IS NULL)) THEN
        RAISE EXCEPTION 'session configured model unavailable' USING ERRCODE='42501';
      END IF;
      -- Retrying an admitted job does not renew an expired session. Otherwise
      -- an old retry could postpone the next session's required revision refresh.
      IF prior IS NULL THEN
        UPDATE messaging.conversations SET ai_agent_profile_version_id=selected WHERE id=c.id;
        UPDATE ops.jobs SET admitted_agent_version_id=selected WHERE id=j.id;
        PERFORM agents.resolve_messaging_memory_session(c.id,selected,p_idle_hours);
        INSERT INTO agents.messaging_session_admissions(job_id,tenant_id,agent_version_id)
          VALUES(j.id,j.tenant_id,selected);
      END IF;
      RETURN selected;
    END $$
    """)
    op.execute("""
      REVOKE ALL ON FUNCTION platform.admit_messaging_session_agent(uuid,text,uuid,integer)
      FROM PUBLIC
    """)
    op.execute("""
      GRANT EXECUTE ON FUNCTION platform.admit_messaging_session_agent(uuid,text,uuid,integer)
      TO platform_messaging
    """)


def downgrade():
    op.execute("""
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM agents.messaging_session_admissions) THEN
        RAISE EXCEPTION 'session admission retention requires archival review';
      END IF;
    END $$
    """)
    op.execute("DROP FUNCTION platform.admit_messaging_session_agent(uuid,text,uuid,integer)")
    op.execute("DROP TABLE agents.messaging_session_admissions")
