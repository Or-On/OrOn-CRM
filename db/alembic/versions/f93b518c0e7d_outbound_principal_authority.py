"""Retain server-derived machine authority and recheck it for physical sends."""

from alembic import op

revision = "f93b518c0e7d"
down_revision = "f82a407bfd6c"
branch_labels = None
depends_on = None


def upgrade():
    # Preserve the exact existing admission guards; memory opt-in controls reuse,
    # not whether a canonical claimed legacy reply has an immutable admission.
    op.execute("""
      DO $guard$
      DECLARE definition text;
        anchor text := $old$        RETURN c.ai_agent_profile_version_id;$old$;
        replacement text := $new$        IF a.published_at IS NULL
          OR a.validation_status<>'valid' OR NOT ('whatsapp'=ANY(a.channel_capabilities)) THEN
          RAISE EXCEPTION 'legacy business Agent unavailable' USING ERRCODE='42501';
        END IF;
        SELECT admission.agent_version_id INTO prior FROM agents.messaging_session_admissions
          admission WHERE admission.job_id=j.id AND admission.tenant_id=j.tenant_id;
        IF prior IS NOT NULL AND prior IS DISTINCT FROM a.id THEN
          RAISE EXCEPTION 'legacy admission changed' USING ERRCODE='42501';
        END IF;
        IF j.admitted_agent_version_id IS NOT NULL AND j.admitted_agent_version_id<>a.id THEN
          RAISE EXCEPTION 'legacy job admission changed' USING ERRCODE='42501';
        END IF;
        INSERT INTO agents.messaging_session_admissions(job_id,tenant_id,agent_version_id)
          VALUES(j.id,j.tenant_id,a.id) ON CONFLICT(job_id) DO NOTHING;
        UPDATE ops.jobs SET admitted_agent_version_id=a.id WHERE id=j.id;
        RETURN c.ai_agent_profile_version_id;$new$;
      BEGIN
        SELECT pg_get_functiondef(
          'platform.admit_messaging_session_agent(uuid,text,uuid,integer)'::regprocedure)
          INTO definition;
        IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
          RAISE EXCEPTION 'legacy admission upgrade anchor drift';
        END IF;
        EXECUTE replace(definition,anchor,replacement);
      END $guard$
    """)
    for statement in (
        """CREATE TABLE platform.outbound_execution_authority(
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
          request_id uuid PRIMARY KEY REFERENCES messaging.outbound_requests(id) ON DELETE RESTRICT,
          source_job_id uuid NOT NULL REFERENCES ops.jobs(id) ON DELETE RESTRICT,
          source_claim_token uuid NOT NULL,
          agent_version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id)
            ON DELETE RESTRICT,
          ownership_epoch bigint NOT NULL,
          mode text NOT NULL CHECK(mode IN ('legacy','principal')),
          principal_id uuid,
          CHECK((mode='principal')=(principal_id IS NOT NULL)),
          FOREIGN KEY(tenant_id,principal_id)
            REFERENCES platform.ai_execution_principals(tenant_id,id) ON DELETE RESTRICT
        )""",
        "ALTER TABLE platform.outbound_execution_authority ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE platform.outbound_execution_authority FORCE ROW LEVEL SECURITY",
        """CREATE POLICY outbound_execution_authority_tenant
          ON platform.outbound_execution_authority
          USING(tenant_id=platform.current_tenant_id())
          WITH CHECK(tenant_id=platform.current_tenant_id())""",
        """CREATE FUNCTION platform.legacy_handoff_outbound_authorized(
          p_request uuid,p_source_job uuid,p_source_claim uuid) RETURNS boolean
          LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT EXISTS(
            SELECT 1 FROM messaging.outbound_requests r
            JOIN messaging.messages m ON m.id=r.message_id AND m.tenant_id=r.tenant_id
            JOIN messaging.conversations c ON c.id=r.conversation_id AND c.tenant_id=r.tenant_id
            JOIN ops.jobs j ON j.id=p_source_job AND j.tenant_id=r.tenant_id
              AND j.reference_id=c.id AND j.reference_type='conversation'
            JOIN agents.messaging_session_admissions admitted
              ON admitted.job_id=j.id AND admitted.tenant_id=j.tenant_id
            JOIN agents.agent_profile_versions a ON a.id=admitted.agent_version_id
              AND a.tenant_id=j.tenant_id AND a.id=j.admitted_agent_version_id
            JOIN agents.agent_profiles profile ON profile.id=a.agent_profile_id
              AND profile.tenant_id=a.tenant_id
            JOIN messaging.messages trigger ON trigger.id=(j.payload->>'triggerMessageId')::uuid
              AND trigger.tenant_id=j.tenant_id AND trigger.conversation_id=c.id
            JOIN messaging.inbound_message_origins origin ON origin.message_id=trigger.id
              AND origin.tenant_id=trigger.tenant_id
            JOIN crm.contact_channel_identities identity ON identity.id=origin.contact_identity_id
              AND identity.tenant_id=c.tenant_id AND identity.contact_id=c.contact_id
            JOIN messaging.channels channel ON channel.id=r.channel_id
              AND channel.tenant_id=c.tenant_id AND channel.id=c.channel_id
            JOIN crm.contacts contact ON contact.id=c.contact_id AND contact.tenant_id=c.tenant_id
            JOIN automation.handoffs handoff ON handoff.conversation_id=c.id
              AND handoff.tenant_id=c.tenant_id AND handoff.contact_id=contact.id
              AND handoff.requested_by_user_id=r.requested_by_user_id
            JOIN audit.records receipt ON receipt.target_id=handoff.id
              AND receipt.tenant_id=handoff.tenant_id AND receipt.target_type='handoff'
              AND receipt.action='conversation.ai_handoff_ticket'
              AND receipt.actor_user_id=r.requested_by_user_id
              AND receipt.metadata->>'sourceJobId'=j.id::text
              AND receipt.metadata->>'aiContextProvenance'='worker_verified_v1'
            WHERE r.id=p_request AND r.tenant_id=platform.current_tenant_id()
              AND platform.current_tenant_active()
              AND platform.current_tenant_feature_enabled('whatsapp')
              AND j.queue='messaging' AND j.job_type='whatsapp.ai.reply'
              AND j.status IN ('running','succeeded') AND j.claim_token=p_source_claim
              AND r.status IN ('queued','sending') AND r.provider='meta'
              AND r.message_kind='text' AND r.explicitly_confirmed
              AND r.idempotency_key='ai-reply:'||j.id::text
              AND m.sender_type='agent' AND m.direction='outbound'
              AND m.content_text IN (
                'נפתחה בקשה לבדיקת נציג. היא עדיין ממתינה לטיפול.',
                'A request for operator review was created and is awaiting attention.')
              AND c.ownership_mode='human' AND c.removed_from_inbox_at IS NULL
              AND c.ai_agent_profile_version_id IS NULL AND c.ai_enabled_by_user_id IS NULL
              AND r.ai_ownership_epoch=c.ownership_epoch
              AND c.handoff_reason_safe=handoff.reason_safe AND handoff.status='pending'
              AND a.published_at IS NOT NULL AND a.validation_status='valid'
              AND 'whatsapp'=ANY(a.channel_capabilities) AND profile.archived_at IS NULL
              AND platform.messaging_ai_actor_authorized(r.requested_by_user_id)
              AND trigger.direction='inbound' AND trigger.sender_type='contact'
              AND trigger.provider='meta' AND identity.channel='whatsapp'
              AND identity.validation_status='valid'
              AND r.recipient_identity_id=origin.contact_identity_id
              AND r.recipient_address=origin.sender_address
              AND regexp_replace(identity.normalized_value,'^\+','','g')=
                regexp_replace(origin.sender_address,'^\+','','g')
              AND channel.kind='whatsapp' AND channel.provider='meta' AND channel.status='active'
              AND contact.lifecycle_status='active' AND contact.whatsapp_consent='granted'
              AND contact.whatsapp_opted_out_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM platform.tenant_ai_execution_bindings binding
                WHERE binding.tenant_id=r.tenant_id AND binding.enabled)
          )
          $$""",
        "REVOKE ALL ON FUNCTION platform.legacy_handoff_outbound_authorized(uuid,uuid,uuid)"
        " FROM PUBLIC",
        """CREATE FUNCTION platform.capture_outbound_execution_authority(
          p_job uuid,p_worker text,p_claim uuid,p_request uuid) RETURNS boolean
          LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
          DECLARE admission jsonb; added integer;
          BEGIN
            admission:=platform.admit_messaging_execution_principal(p_job,p_worker,p_claim);
            IF admission IS NULL OR admission->>'mode' NOT IN ('legacy','principal') THEN
              -- Only the exact server-recorded legacy handoff may acknowledge
              -- its own completed ownership transition. Model-only principals
              -- cannot acquire business write authority through this branch.
              IF NOT platform.legacy_handoff_outbound_authorized(p_request,p_job,p_claim)
                THEN RETURN false; END IF;
              INSERT INTO platform.outbound_execution_authority
                (tenant_id,request_id,source_job_id,source_claim_token,agent_version_id,ownership_epoch,mode)
              SELECT j.tenant_id,r.id,j.id,p_claim,admitted.agent_version_id,
                c.ownership_epoch,'legacy'
              FROM ops.jobs j JOIN agents.messaging_session_admissions admitted
                ON admitted.job_id=j.id AND admitted.tenant_id=j.tenant_id
              JOIN messaging.outbound_requests r ON r.id=p_request AND r.tenant_id=j.tenant_id
              JOIN messaging.conversations c ON c.id=r.conversation_id AND c.tenant_id=r.tenant_id
              WHERE j.id=p_job AND j.tenant_id=platform.current_tenant_id()
                AND j.status='running' AND j.locked_by=p_worker AND j.claim_token=p_claim
                AND j.lease_expires_at>clock_timestamp()
              ON CONFLICT DO NOTHING;
              GET DIAGNOSTICS added=ROW_COUNT;
              RETURN added=1;
            END IF;
            INSERT INTO platform.outbound_execution_authority
              (tenant_id,request_id,source_job_id,source_claim_token,agent_version_id,ownership_epoch,
                mode,principal_id)
            SELECT j.tenant_id,r.id,j.id,p_claim,c.ai_agent_profile_version_id,c.ownership_epoch,
              admission->>'mode',(admission->>'principalId')::uuid
            FROM ops.jobs j JOIN messaging.conversations c
              ON c.tenant_id=j.tenant_id AND c.id=j.reference_id
            JOIN messaging.outbound_requests r
              ON r.tenant_id=c.tenant_id AND r.conversation_id=c.id
            JOIN messaging.messages m ON m.id=r.message_id AND m.tenant_id=r.tenant_id
            WHERE j.id=p_job AND j.tenant_id=platform.current_tenant_id()
              AND r.id=p_request AND r.status='queued' AND m.sender_type='agent'
              AND r.ai_ownership_epoch=c.ownership_epoch
              AND r.requested_by_user_id=c.ai_enabled_by_user_id
              AND r.idempotency_key='ai-reply:'||j.id::text
            ON CONFLICT DO NOTHING;
            GET DIAGNOSTICS added=ROW_COUNT;
            RETURN added=1;
          END $$""",
        """CREATE FUNCTION platform.outbound_execution_authorized(
          p_job uuid,p_worker text,p_claim uuid) RETURNS boolean
          LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
          DECLARE retained platform.outbound_execution_authority%ROWTYPE;
            binding platform.tenant_ai_execution_bindings%ROWTYPE;
            principal platform.ai_execution_principals%ROWTYPE;
            agent_sender boolean;
          BEGIN
            SELECT m.sender_type='agent' INTO agent_sender
            FROM ops.jobs j JOIN messaging.outbound_requests r
              ON r.id=j.reference_id AND r.tenant_id=j.tenant_id
            JOIN messaging.messages m ON m.id=r.message_id AND m.tenant_id=r.tenant_id
            JOIN public.tenants t ON t.id=j.tenant_id AND t.status='active'
            WHERE j.id=p_job AND j.tenant_id=platform.current_tenant_id()
              AND j.job_type='whatsapp.outbound.send' AND j.status='running'
              AND j.locked_by=p_worker AND j.claim_token=p_claim
              AND j.lease_expires_at>clock_timestamp() AND r.status='sending';
            IF NOT FOUND THEN RETURN false; END IF;
            IF NOT agent_sender THEN RETURN true; END IF;
            SELECT * INTO binding FROM platform.tenant_ai_execution_bindings
              WHERE tenant_id=platform.current_tenant_id() FOR SHARE;
            SELECT authority.* INTO retained FROM platform.outbound_execution_authority authority
              JOIN ops.jobs j ON j.reference_id=authority.request_id 
                AND j.tenant_id=authority.tenant_id
              WHERE j.id=p_job AND authority.tenant_id=platform.current_tenant_id();
            IF retained.request_id IS NULL THEN
              -- Historic/default-off automated messages retain legacy behavior.
              RETURN NOT COALESCE(binding.enabled,false);
            END IF;
            IF retained.mode='legacy' THEN
              IF COALESCE(binding.enabled,false) THEN RETURN false; END IF;
              PERFORM 1 FROM messaging.outbound_requests r
                JOIN messaging.conversations c ON c.id=r.conversation_id AND c.tenant_id=r.tenant_id
                JOIN ops.jobs source ON source.id=retained.source_job_id
                  AND source.tenant_id=retained.tenant_id
                JOIN agents.agent_profile_versions a ON a.id=retained.agent_version_id
                  AND a.tenant_id=retained.tenant_id
                JOIN agents.agent_profiles profile ON profile.id=a.agent_profile_id
                  AND profile.tenant_id=a.tenant_id
                WHERE r.id=retained.request_id AND r.tenant_id=retained.tenant_id
                  AND r.ai_ownership_epoch=c.ownership_epoch
                  AND c.ownership_epoch=retained.ownership_epoch
                  AND c.removed_from_inbox_at IS NULL
                  AND platform.messaging_ai_actor_authorized(r.requested_by_user_id)
                  AND a.published_at IS NOT NULL AND a.validation_status='valid'
                  AND 'whatsapp'=ANY(a.channel_capabilities) AND profile.archived_at IS NULL
                  AND ((c.ownership_mode='ai'
                    AND c.ai_agent_profile_version_id=retained.agent_version_id
                    AND c.ai_enabled_by_user_id=r.requested_by_user_id)
                    OR platform.legacy_handoff_outbound_authorized(
                      r.id,source.id,retained.source_claim_token));
              RETURN FOUND;
            END IF;
            IF NOT COALESCE(binding.enabled,false)
              OR binding.principal_id IS DISTINCT FROM retained.principal_id
              THEN RETURN false; END IF;
            SELECT * INTO principal FROM platform.ai_execution_principals
              WHERE tenant_id=retained.tenant_id AND id=retained.principal_id FOR SHARE;
            IF NOT FOUND OR principal.status<>'active' OR principal.membership_status<>'active'
              OR principal.role<>'conversation_model_reader_v1' THEN RETURN false; END IF;
            PERFORM 1 FROM messaging.outbound_requests r
              JOIN messaging.conversations c ON c.id=r.conversation_id AND c.tenant_id=r.tenant_id
              JOIN agents.agent_profile_versions a ON a.id=retained.agent_version_id
                AND a.tenant_id=c.tenant_id
              JOIN agents.agent_profiles profile ON profile.id=a.agent_profile_id
                AND profile.tenant_id=a.tenant_id
              WHERE r.id=retained.request_id AND r.tenant_id=retained.tenant_id
              AND c.ownership_mode='ai' AND c.removed_from_inbox_at IS NULL
              AND c.ownership_epoch=retained.ownership_epoch
              AND c.ai_agent_profile_version_id=retained.agent_version_id
              AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
              AND c.ai_enabled_by_user_id=r.requested_by_user_id
              AND a.published_at IS NOT NULL AND a.validation_status='valid'
              AND 'whatsapp'=ANY(a.channel_capabilities)
              AND to_jsonb(a.tool_permissions)='[]'::jsonb AND profile.archived_at IS NULL;
            RETURN FOUND;
          END $$""",
        "REVOKE ALL ON FUNCTION platform.capture_outbound_execution_authority(uuid,text,uuid,uuid)"
        " FROM PUBLIC",
        "REVOKE ALL ON FUNCTION platform.outbound_execution_authorized(uuid,text,uuid) FROM PUBLIC",
        "GRANT EXECUTE ON FUNCTION "
        "platform.capture_outbound_execution_authority(uuid,text,uuid,uuid)"
        " TO platform_messaging",
        "GRANT EXECUTE ON FUNCTION platform.outbound_execution_authorized(uuid,text,uuid)"
        " TO platform_messaging",
    ):
        op.execute(statement)
    op.execute("""DO $$ DECLARE body text; anchor text :=
      'AND platform.messaging_ai_actor_authorized(r.requested_by_user_id)';
      BEGIN
        SELECT pg_get_functiondef(
          'platform.messaging_outbound_channel_credential(uuid,text,uuid)'::regprocedure)
          INTO body;
        IF length(body)-length(replace(body,anchor,'')) <> length(anchor) THEN
          RAISE EXCEPTION 'outbound_credential_guard_drift';
        END IF;
        EXECUTE replace(body,anchor,anchor||
          ' AND platform.outbound_execution_authorized(p_job,p_worker,p_claim)');
      END $$""")


def downgrade():
    op.execute("""DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM platform.outbound_execution_authority) THEN
        RAISE EXCEPTION 'outbound_principal_evidence_requires_reviewed_retention';
      END IF;
    END $$""")
    op.execute("""DO $$ DECLARE body text; anchor text :=
      ' AND platform.outbound_execution_authorized(p_job,p_worker,p_claim)';
      BEGIN
        SELECT pg_get_functiondef(
          'platform.messaging_outbound_channel_credential(uuid,text,uuid)'::regprocedure)
          INTO body;
        IF length(body)-length(replace(body,anchor,'')) <> length(anchor) THEN
          RAISE EXCEPTION 'outbound_credential_guard_drift';
        END IF;
        EXECUTE replace(body,anchor,'');
      END $$""")
    op.execute("""
      DO $guard$
      DECLARE definition text;
        anchor text := $old$        IF a.published_at IS NULL
          OR a.validation_status<>'valid' OR NOT ('whatsapp'=ANY(a.channel_capabilities)) THEN
          RAISE EXCEPTION 'legacy business Agent unavailable' USING ERRCODE='42501';
        END IF;
        SELECT admission.agent_version_id INTO prior FROM agents.messaging_session_admissions
          admission WHERE admission.job_id=j.id AND admission.tenant_id=j.tenant_id;
        IF prior IS NOT NULL AND prior IS DISTINCT FROM a.id THEN
          RAISE EXCEPTION 'legacy admission changed' USING ERRCODE='42501';
        END IF;
        IF j.admitted_agent_version_id IS NOT NULL AND j.admitted_agent_version_id<>a.id THEN
          RAISE EXCEPTION 'legacy job admission changed' USING ERRCODE='42501';
        END IF;
        INSERT INTO agents.messaging_session_admissions(job_id,tenant_id,agent_version_id)
          VALUES(j.id,j.tenant_id,a.id) ON CONFLICT(job_id) DO NOTHING;
        UPDATE ops.jobs SET admitted_agent_version_id=a.id WHERE id=j.id;
        RETURN c.ai_agent_profile_version_id;$old$;
      BEGIN
        SELECT pg_get_functiondef(
          'platform.admit_messaging_session_agent(uuid,text,uuid,integer)'::regprocedure)
          INTO definition;
        IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
          RAISE EXCEPTION 'legacy admission downgrade anchor drift';
        END IF;
        EXECUTE replace(definition,anchor,$new$        RETURN c.ai_agent_profile_version_id;$new$);
      END $guard$
    """)
    op.execute("DROP FUNCTION platform.outbound_execution_authorized(uuid,text,uuid)")
    op.execute("DROP FUNCTION platform.capture_outbound_execution_authority(uuid,text,uuid,uuid)")
    op.execute("DROP TABLE platform.outbound_execution_authority")
    op.execute("DROP FUNCTION platform.legacy_handoff_outbound_authorized(uuid,uuid,uuid)")
