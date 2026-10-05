"""Retain authorized handoff and failed-model acknowledgements."""

from alembic import op

revision = "d7b80a4c913e"
down_revision = "c8e71b4a209d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE TABLE platform.principal_handoff_authority(
        tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
        source_job_id uuid NOT NULL,
        source_claim_token uuid NOT NULL,
        handoff_id uuid NOT NULL REFERENCES automation.handoffs(id) ON DELETE CASCADE,
        principal_id uuid NOT NULL,
        agent_version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id)
          ON DELETE RESTRICT,
        conversation_id uuid NOT NULL,
        consent_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
        ownership_epoch bigint NOT NULL,
        inbox_reopened_at timestamptz,
        authority_snapshot jsonb NOT NULL,
        menu_snapshot jsonb NOT NULL,
        PRIMARY KEY(tenant_id,source_job_id),
        FOREIGN KEY(tenant_id,source_job_id) REFERENCES ops.jobs(tenant_id,id) ON DELETE CASCADE,
        FOREIGN KEY(tenant_id,conversation_id)
          REFERENCES messaging.conversations(tenant_id,id) ON DELETE CASCADE,
        FOREIGN KEY(tenant_id,principal_id)
          REFERENCES platform.ai_execution_principals(tenant_id,id) ON DELETE RESTRICT)
    """)
    op.execute("ALTER TABLE platform.principal_handoff_authority ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE platform.principal_handoff_authority FORCE ROW LEVEL SECURITY")
    op.execute("""CREATE POLICY principal_handoff_tenant ON platform.principal_handoff_authority
      USING(tenant_id=platform.current_tenant_id())
      WITH CHECK(tenant_id=platform.current_tenant_id())""")
    op.execute("""GRANT SELECT,INSERT ON platform.principal_handoff_authority
      TO platform_migrator""")
    op.execute("""
      CREATE FUNCTION platform.handoff_execution_snapshot(p_agent uuid,p_principal uuid)
      RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT jsonb_build_object('grants',COALESCE((SELECT jsonb_agg(
          jsonb_build_object('capability',g.capability,'flowVersionId',g.flow_version_id,
            'agentVersionId',g.agent_version_id,'enabled',g.enabled) ORDER BY g.capability)
          FROM platform.machine_tool_grants g WHERE g.tenant_id=platform.current_tenant_id()
            AND g.principal_id=p_principal AND g.agent_version_id=p_agent),'[]'::jsonb),
          'release',(SELECT jsonb_build_object('id',r.id,'version',r.version,
            'configuration',r.configuration) FROM platform.tenant_configuration_releases r
            WHERE r.tenant_id=platform.current_tenant_id() AND r.status='published'
            ORDER BY r.version DESC,r.id DESC LIMIT 1))
      $$
    """)
    op.execute("""
      CREATE FUNCTION platform.capture_principal_handoff_authority(
        p_job uuid,p_worker text,p_claim uuid,p_handoff uuid) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE admission jsonb; c messaging.conversations%ROWTYPE;
        a agents.agent_profile_versions%ROWTYPE; menu jsonb; snapshot jsonb;
        saved platform.principal_handoff_authority%ROWTYPE;
      BEGIN
        admission:=platform.admit_messaging_execution_principal(p_job,p_worker,p_claim);
        IF admission->>'mode'='legacy' THEN RETURN true; END IF;
        IF admission IS NULL OR admission->>'mode'<>'principal' THEN RETURN false; END IF;
        SELECT conversation.* INTO c FROM ops.jobs j
          JOIN messaging.conversations conversation ON conversation.tenant_id=j.tenant_id
            AND conversation.id=j.reference_id
          JOIN automation.handoffs h ON h.tenant_id=j.tenant_id AND h.id=p_handoff
            AND h.conversation_id=conversation.id AND h.contact_id=conversation.contact_id
            AND h.requested_by_user_id=conversation.ai_enabled_by_user_id
            AND h.source_channel='whatsapp' AND h.status='pending'
            AND h.idempotency_key='ai-handoff:'||j.id::text
          JOIN audit.records receipt ON receipt.tenant_id=h.tenant_id
            AND receipt.target_type='handoff' AND receipt.target_id=h.id
            AND receipt.action='conversation.ai_handoff_ticket'
            AND receipt.actor_user_id=conversation.ai_enabled_by_user_id
            AND receipt.metadata->>'sourceJobId'=j.id::text
            AND receipt.metadata->>'aiContextProvenance'='worker_verified_v1'
          WHERE j.tenant_id=platform.current_tenant_id() AND j.id=p_job
            AND j.status='running' AND j.locked_by=p_worker AND j.claim_token=p_claim
            AND j.lease_expires_at>clock_timestamp() AND j.job_type='whatsapp.ai.reply'
            AND conversation.ownership_mode='ai' AND conversation.removed_from_inbox_at IS NULL
            AND conversation.ai_agent_profile_version_id=j.admitted_agent_version_id
          FOR UPDATE OF conversation;
        IF NOT FOUND THEN RETURN false; END IF;
        SELECT * INTO a FROM agents.agent_profile_versions WHERE tenant_id=c.tenant_id
          AND id=c.ai_agent_profile_version_id FOR SHARE;
        IF NOT platform.machine_agent_tools_authorized(a.id,(admission->>'principalId')::uuid)
          THEN RETURN false; END IF;
        PERFORM 1 FROM platform.machine_tool_grants WHERE tenant_id=c.tenant_id FOR SHARE;
        PERFORM 1 FROM platform.tenant_configuration_releases WHERE tenant_id=c.tenant_id FOR SHARE;
        snapshot:=platform.handoff_execution_snapshot(a.id,(admission->>'principalId')::uuid);
        IF a.tool_permissions<>'[]'::jsonb AND NOT EXISTS(
          SELECT 1 FROM platform.machine_tool_claims claim WHERE claim.tenant_id=c.tenant_id
            AND claim.job_id=p_job AND claim.claim_token=p_claim
            AND claim.conversation_id=c.id AND claim.contact_id=c.contact_id
            AND claim.agent_version_id=a.id AND claim.consent_user_id=c.ai_enabled_by_user_id
            AND claim.ownership_epoch=c.ownership_epoch
            AND claim.principal_id=(admission->>'principalId')::uuid
            AND claim.authority_snapshot=snapshot) THEN RETURN false; END IF;
        SELECT to_jsonb(cfg) INTO menu FROM platform.whatsapp_opening_menu_configuration cfg
          WHERE cfg.tenant_id=c.tenant_id AND cfg.channel_id=c.channel_id FOR SHARE;
        menu:=coalesce(menu,'{}'::jsonb);
        IF coalesce((menu->>'enabled')::boolean,false)
          AND NOT platform.opening_menu_legacy_session(c.id)
          AND NOT EXISTS(SELECT 1 FROM platform.whatsapp_opening_menu_operations operation
            JOIN platform.whatsapp_opening_menu_state state ON state.tenant_id=operation.tenant_id
              AND state.conversation_id=operation.conversation_id
            WHERE operation.tenant_id=c.tenant_id AND operation.job_id=p_job
              AND operation.conversation_id=c.id AND operation.ownership_epoch=c.ownership_epoch
              AND operation.configuration_snapshot=menu AND operation.decision->>'kind'='route'
              AND operation.decision->>'generation'=state.generation::text
              AND operation.decision->>'intent'=state.route_intent AND state.status='chosen'
              AND state.ownership_epoch=c.ownership_epoch
              AND state.inbox_reopened_at IS NOT DISTINCT FROM c.inbox_reopened_at)
          THEN RETURN false; END IF;
        INSERT INTO platform.principal_handoff_authority(tenant_id,source_job_id,source_claim_token,
          handoff_id,principal_id,agent_version_id,conversation_id,consent_user_id,ownership_epoch,
          inbox_reopened_at,authority_snapshot,menu_snapshot)
        VALUES(c.tenant_id,p_job,p_claim,p_handoff,(admission->>'principalId')::uuid,a.id,c.id,
          c.ai_enabled_by_user_id,c.ownership_epoch,c.inbox_reopened_at,snapshot,menu)
        ON CONFLICT DO NOTHING;
        SELECT * INTO saved FROM platform.principal_handoff_authority
          WHERE tenant_id=c.tenant_id AND source_job_id=p_job;
        RETURN saved.source_claim_token=p_claim AND saved.handoff_id=p_handoff
          AND saved.principal_id=(admission->>'principalId')::uuid
          AND saved.agent_version_id=a.id AND saved.conversation_id=c.id
          AND saved.consent_user_id=c.ai_enabled_by_user_id
          AND saved.ownership_epoch=c.ownership_epoch
          AND saved.inbox_reopened_at IS NOT DISTINCT FROM c.inbox_reopened_at
          AND saved.authority_snapshot=snapshot AND saved.menu_snapshot=menu;
      END $$
    """)
    # Reuse the full legacy acknowledgement guard (fixed text, verified origin,
    # consent, immutable admission and protected audit) with a separate principal
    # receipt. This does not broaden the legacy path or authorize ordinary replies.
    op.execute("""
      DO $patch$ DECLARE body text; anchor text;
      BEGIN
        body:=pg_get_functiondef('platform.legacy_handoff_outbound_authorized(uuid,uuid,uuid)'::regprocedure);
        body:=replace(body,'platform.legacy_handoff_outbound_authorized(',
          'platform.principal_handoff_outbound_authorized(');
        anchor:='AND NOT EXISTS(SELECT 1 FROM platform.tenant_ai_execution_bindings binding'
          ||E'\\n                WHERE binding.tenant_id=r.tenant_id AND binding.enabled)';
        IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN
          RAISE EXCEPTION 'principal handoff guard anchor drift'; END IF;
        body:=replace(body,anchor,$guard$
          AND EXISTS(SELECT 1 FROM platform.principal_handoff_authority saved
            JOIN platform.tenant_ai_execution_bindings binding ON binding.tenant_id=saved.tenant_id
              AND binding.enabled AND binding.principal_id=saved.principal_id
            WHERE saved.tenant_id=r.tenant_id AND saved.source_job_id=j.id
              AND saved.source_claim_token=p_source_claim AND saved.handoff_id=handoff.id
              AND saved.agent_version_id=a.id AND saved.conversation_id=c.id
              AND saved.consent_user_id=r.requested_by_user_id
              AND c.ownership_epoch=saved.ownership_epoch+1
              AND c.inbox_reopened_at IS NOT DISTINCT FROM saved.inbox_reopened_at
              AND platform.machine_agent_tools_authorized(a.id,saved.principal_id)
              AND saved.authority_snapshot=
                platform.handoff_execution_snapshot(a.id,saved.principal_id)
              AND saved.menu_snapshot=COALESCE((SELECT to_jsonb(cfg)
                FROM platform.whatsapp_opening_menu_configuration cfg
                WHERE cfg.tenant_id=c.tenant_id
                  AND cfg.channel_id=c.channel_id),'{}'::jsonb))
        $guard$);
        EXECUTE body;
      END $patch$
    """)
    op.execute("""
      DO $patch$ DECLARE body text; anchor text;
      BEGIN
        body:=pg_get_functiondef('platform.capture_outbound_execution_authority(uuid,text,uuid,uuid)'::regprocedure);
        anchor:='IF NOT platform.legacy_handoff_outbound_authorized(p_request,p_job,p_claim)';
        IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN
          RAISE EXCEPTION 'principal handoff capture anchor drift'; END IF;
        EXECUTE replace(body,anchor,$capture$
          IF platform.principal_handoff_outbound_authorized(p_request,p_job,p_claim) THEN
            INSERT INTO platform.outbound_execution_authority
              (tenant_id,request_id,source_job_id,source_claim_token,agent_version_id,
                ownership_epoch,mode,principal_id)
            SELECT saved.tenant_id,r.id,saved.source_job_id,saved.source_claim_token,
              saved.agent_version_id,c.ownership_epoch,'principal',saved.principal_id
            FROM platform.principal_handoff_authority saved
            JOIN ops.jobs j ON j.tenant_id=saved.tenant_id AND j.id=saved.source_job_id
            JOIN messaging.conversations c ON c.tenant_id=saved.tenant_id
              AND c.id=saved.conversation_id
            JOIN messaging.outbound_requests r ON r.tenant_id=c.tenant_id AND r.conversation_id=c.id
            WHERE saved.tenant_id=platform.current_tenant_id() AND saved.source_job_id=p_job
              AND r.id=p_request AND j.status='running' AND j.locked_by=p_worker
              AND j.claim_token=p_claim AND j.lease_expires_at>clock_timestamp()
            ON CONFLICT DO NOTHING;
            GET DIAGNOSTICS added=ROW_COUNT; RETURN added=1;
          END IF;
          IF NOT platform.legacy_handoff_outbound_authorized(p_request,p_job,p_claim)
        $capture$);
        body:=pg_get_functiondef('platform.outbound_execution_authorized(uuid,text,uuid)'::regprocedure);
        -- The first occurrence is the unchanged legacy branch; only patch the
        -- principal branch after its explicit live-principal checks.
        anchor:='IF NOT FOUND OR principal.status<>''active'''
          ||' OR principal.membership_status<>''active'''
          ||E'\\n              OR principal.role<>''conversation_model_reader_v1'''
          ||' THEN RETURN false; END IF;';
        IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN
          RAISE EXCEPTION 'principal handoff outbound anchor drift'; END IF;
        EXECUTE replace(body,anchor,anchor||$outbound$
          IF platform.principal_handoff_outbound_authorized(
            retained.request_id,retained.source_job_id,retained.source_claim_token) THEN
            RETURN EXISTS(SELECT 1 FROM platform.principal_handoff_authority saved
              WHERE saved.tenant_id=retained.tenant_id
                AND saved.source_job_id=retained.source_job_id
                AND saved.source_claim_token=retained.source_claim_token
                AND saved.principal_id=retained.principal_id
                AND saved.agent_version_id=retained.agent_version_id
                AND saved.ownership_epoch+1=retained.ownership_epoch);
          END IF;
        $outbound$);
        body:=pg_get_functiondef('platform.opening_menu_business_job_allowed(uuid,text,uuid)'::regprocedure);
        anchor:='IF NOT FOUND OR NOT cfg.enabled OR '
          ||'platform.opening_menu_legacy_session(c.id) THEN';
        IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN
          RAISE EXCEPTION 'principal handoff menu anchor drift'; END IF;
        EXECUTE replace(body,anchor,$menu$
          IF j.job_type='whatsapp.outbound.send' AND EXISTS(
            SELECT 1 FROM platform.outbound_execution_authority authority
              WHERE authority.tenant_id=j.tenant_id AND authority.request_id=j.reference_id
                AND authority.mode='principal'
                AND platform.principal_handoff_outbound_authorized(authority.request_id,
                  authority.source_job_id,authority.source_claim_token)) THEN
            RETURN EXISTS(SELECT 1 FROM ops.jobs fresh WHERE fresh.id=j.id
              AND fresh.tenant_id=j.tenant_id
              AND fresh.status='running' AND fresh.locked_by=p_worker AND fresh.claim_token=p_claim
              AND fresh.lease_expires_at>clock_timestamp());
          END IF;
        $menu$||anchor);
      END $patch$
    """)
    op.execute("""
      DO $patch$ DECLARE body text; anchor text;
      BEGIN
        body:=pg_get_functiondef(
          'platform.capture_outbound_execution_authority(uuid,text,uuid,uuid)'::regprocedure);
        anchor:='AND r.idempotency_key=''ai-reply:''||j.id::text';
        IF (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN
          RAISE EXCEPTION 'principal fallback capture anchor drift'; END IF;
        EXECUTE replace(body,anchor,$fallback$
          AND (r.idempotency_key='ai-reply:'||j.id::text OR (
            r.idempotency_key='ai-fallback:'||j.id::text
            AND r.message_kind='text' AND r.explicitly_confirmed
            AND m.content_text IN ('קיבלתי את ההודעה. אבדוק ואחזור אליך.',
              'Got it. I will check and get back to you.')
            AND EXISTS(SELECT 1 FROM audit.records receipt
              WHERE receipt.tenant_id=j.tenant_id AND receipt.target_type='job'
                AND receipt.target_id=j.id AND receipt.action='conversation.ai_model_failure'
                AND receipt.actor_user_id=r.requested_by_user_id
                AND receipt.metadata->>'sourceJobId'=j.id::text
                AND receipt.metadata->>'conversationId'=c.id::text
                AND receipt.metadata->>'triggerMessageId'=j.payload->>'triggerMessageId'
                AND receipt.metadata->>'aiContextProvenance'='worker_verified_v1')))
        $fallback$);
      END $patch$
    """)
    for signature in (
        "platform.handoff_execution_snapshot(uuid,uuid)",
        "platform.capture_principal_handoff_authority(uuid,text,uuid,uuid)",
        "platform.principal_handoff_outbound_authorized(uuid,uuid,uuid)",
    ):
        op.execute(f"ALTER FUNCTION {signature} OWNER TO platform_migrator")
        op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
    op.execute("""GRANT EXECUTE ON FUNCTION
      platform.capture_principal_handoff_authority(uuid,text,uuid,uuid) TO platform_messaging""")


def downgrade() -> None:
    # Keep acknowledgement receipts and guards for in-flight mixed-version jobs.
    pass
