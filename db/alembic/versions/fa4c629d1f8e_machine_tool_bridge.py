# ruff: noqa: E501
# Exact SQL guard anchors and immutable quoted literals retain their original bytes.
"""Prepared narrow machine tool authority; default-empty grants preserve denial."""

from alembic import op

revision = "fa4c629d1f8e"
down_revision = "f93b518c0e7d"
branch_labels = None
depends_on = None


def upgrade():
    statements = (
        """CREATE TABLE platform.machine_tool_grants(
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
          principal_id uuid NOT NULL,
          agent_version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id) ON DELETE
          RESTRICT,
          flow_version_id uuid NOT NULL REFERENCES automation.flow_versions(id) ON DELETE RESTRICT,
          capability text NOT NULL CHECK(capability IN
            ('lead.read','lead.write','lead.finalize','lead.follow_up','ticket.open','service.intake')),
          enabled boolean NOT NULL DEFAULT false,
          PRIMARY KEY(tenant_id,principal_id,agent_version_id,capability),
          FOREIGN KEY(tenant_id,principal_id)
            REFERENCES platform.ai_execution_principals(tenant_id,id) ON DELETE RESTRICT)""",
        "ALTER TABLE platform.machine_tool_grants ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE platform.machine_tool_grants FORCE ROW LEVEL SECURITY",
        """CREATE POLICY machine_tool_grants_tenant ON platform.machine_tool_grants
          USING(tenant_id=platform.current_tenant_id())
          WITH CHECK(tenant_id=platform.current_tenant_id())""",
        "GRANT SELECT,INSERT,UPDATE,DELETE ON platform.machine_tool_grants TO platform_migrator",
        """CREATE TABLE platform.machine_tool_claims(
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
          job_id uuid NOT NULL REFERENCES ops.jobs(id) ON DELETE RESTRICT,
          claim_token uuid NOT NULL,
          principal_id uuid NOT NULL,
          agent_version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id) ON DELETE
          RESTRICT,
          conversation_id uuid NOT NULL REFERENCES messaging.conversations(id) ON DELETE RESTRICT,
          contact_id uuid NOT NULL REFERENCES crm.contacts(id) ON DELETE RESTRICT,
          consent_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
          source_message_id uuid NOT NULL REFERENCES messaging.messages(id) ON DELETE RESTRICT,
          ownership_epoch bigint NOT NULL,
          authority_snapshot jsonb NOT NULL,
          PRIMARY KEY(tenant_id,job_id,claim_token),
          FOREIGN KEY(tenant_id,principal_id)
            REFERENCES platform.ai_execution_principals(tenant_id,id) ON DELETE RESTRICT)""",
        "ALTER TABLE platform.machine_tool_claims ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE platform.machine_tool_claims FORCE ROW LEVEL SECURITY",
        """CREATE POLICY machine_tool_claims_tenant ON platform.machine_tool_claims
          USING(tenant_id=platform.current_tenant_id())
          WITH CHECK(tenant_id=platform.current_tenant_id())""",
        """CREATE TABLE platform.machine_tool_receipts(
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
          job_id uuid NOT NULL REFERENCES ops.jobs(id) ON DELETE RESTRICT,
          operation_key text NOT NULL,
          principal_id uuid NOT NULL,
          capability text NOT NULL,
          agent_version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id) ON DELETE
          RESTRICT,
          contact_id uuid NOT NULL REFERENCES crm.contacts(id) ON DELETE RESTRICT,
          conversation_id uuid NOT NULL REFERENCES messaging.conversations(id) ON DELETE RESTRICT,
          consent_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
          ownership_epoch bigint NOT NULL,
          resource_id uuid NOT NULL,
          arguments_digest text,
          committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY(tenant_id,job_id,operation_key),
          FOREIGN KEY(tenant_id,principal_id)
            REFERENCES platform.ai_execution_principals(tenant_id,id) ON DELETE RESTRICT)""",
        "ALTER TABLE platform.machine_tool_receipts ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE platform.machine_tool_receipts FORCE ROW LEVEL SECURITY",
        """CREATE POLICY machine_tool_receipts_tenant ON platform.machine_tool_receipts
          USING(tenant_id=platform.current_tenant_id())
          WITH CHECK(tenant_id=platform.current_tenant_id())""",
    )
    for statement in statements:
        op.execute(statement)
    op.execute("""CREATE FUNCTION platform.machine_agent_tools_authorized(
      p_agent uuid,p_principal uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      SELECT EXISTS(SELECT 1 FROM agents.agent_profile_versions a
        JOIN agents.agent_profiles profile ON profile.id=a.agent_profile_id
          AND profile.tenant_id=a.tenant_id AND profile.archived_at IS NULL
        JOIN platform.ai_execution_principals principal ON principal.tenant_id=a.tenant_id
          AND principal.id=p_principal AND principal.status='active'
          AND principal.membership_status='active'
          AND principal.role='conversation_model_reader_v1'
        WHERE a.id=p_agent AND a.tenant_id=platform.current_tenant_id()
          AND a.published_at IS NOT NULL AND a.validation_status='valid'
          AND 'whatsapp'=ANY(a.channel_capabilities)
          AND platform.current_tenant_feature_enabled('agents')
          AND platform.current_tenant_feature_enabled('contacts')
          AND platform.current_tenant_feature_enabled('whatsapp')
          AND jsonb_typeof(a.tool_permissions)='array'
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(a.tool_permissions)
          requested(capability)
            WHERE NOT EXISTS(SELECT 1 FROM platform.machine_tool_grants grant_row
              JOIN automation.flow_versions flow ON flow.id=grant_row.flow_version_id
                AND flow.tenant_id=grant_row.tenant_id AND flow.agent_profile_version_id=a.id
              WHERE grant_row.tenant_id=a.tenant_id AND grant_row.principal_id=p_principal
                AND grant_row.agent_version_id=a.id AND grant_row.capability=requested.capability
                AND grant_row.enabled
                AND platform.approved_flow_for_channel(flow.id,a.id,'whatsapp')
                AND platform.current_tenant_feature_enabled(CASE
                  WHEN requested.capability LIKE 'lead.%' THEN 'leads'
                  WHEN requested.capability='ticket.open' THEN 'tickets'
                  WHEN requested.capability='service.intake' THEN 'field_service'
                  ELSE '__unsupported__' END))))
      $$""")
    op.execute("""CREATE FUNCTION platform.authorize_machine_tool(
      p_job uuid,p_worker text,p_claim uuid,p_capability text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE j ops.jobs%ROWTYPE; c messaging.conversations%ROWTYPE;
        b platform.tenant_ai_execution_bindings%ROWTYPE;
        principal platform.ai_execution_principals%ROWTYPE;
        a agents.agent_profile_versions%ROWTYPE; source_message uuid;
        retained platform.machine_tool_claims%ROWTYPE; latest_message uuid;
        v_authority_snapshot jsonb;
      BEGIN
        IF p_capability NOT IN ('lead.read','lead.write','lead.finalize','lead.follow_up',
          'ticket.open','service.intake') THEN
          RAISE EXCEPTION 'machine_tool_denied' USING ERRCODE='42501';
        END IF;
        SELECT * INTO j FROM ops.jobs WHERE id=p_job AND tenant_id=platform.current_tenant_id()
          AND queue='messaging' AND status='running' AND locked_by=p_worker
          AND claim_token=p_claim AND lease_expires_at>clock_timestamp()
          AND (job_type='whatsapp.ai.reply' OR (job_type='whatsapp.ai.call' AND
          p_capability='ticket.open') OR
            (job_type='field_service.intake.extract' AND p_capability='service.intake'))
          FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'machine_tool_stale_claim' USING ERRCODE='42501'; END IF;
        IF j.job_type IN ('whatsapp.ai.reply','whatsapp.ai.call') THEN
          SELECT * INTO c FROM messaging.conversations
            WHERE tenant_id=j.tenant_id AND id=j.reference_id FOR UPDATE;
          source_message:=CASE WHEN j.job_type='whatsapp.ai.call' THEN j.callback_trigger_message_id
            ELSE (j.payload->>'triggerMessageId')::uuid END;
        ELSE
          SELECT conversation.* INTO c FROM messaging.messages m
            JOIN messaging.conversations conversation ON conversation.id=m.conversation_id
              AND conversation.tenant_id=m.tenant_id
            WHERE m.id=j.reference_id AND m.tenant_id=j.tenant_id AND m.direction='inbound'
            FOR UPDATE OF conversation;
          source_message:=j.reference_id;
        END IF;
        SELECT * INTO b FROM platform.tenant_ai_execution_bindings
          WHERE tenant_id=j.tenant_id FOR SHARE;
        IF NOT FOUND OR NOT b.enabled THEN
          IF EXISTS(SELECT 1 FROM platform.machine_tool_claims prior
            WHERE prior.tenant_id=j.tenant_id AND prior.job_id=j.id) THEN
            RAISE EXCEPTION 'machine_tool_job_binding_changed' USING ERRCODE='42501'; END IF;
          RETURN jsonb_build_object('mode','legacy'); END IF;
        IF j.job_type='whatsapp.ai.call' THEN
          RAISE EXCEPTION 'machine_callback_capability_not_admitted' USING ERRCODE='42501'; END IF;
        SELECT * INTO principal FROM platform.ai_execution_principals
          WHERE tenant_id=j.tenant_id AND id=b.principal_id FOR SHARE;
        SELECT * INTO a FROM agents.agent_profile_versions
          WHERE tenant_id=j.tenant_id AND id=c.ai_agent_profile_version_id FOR SHARE;
        PERFORM 1 FROM agents.agent_profiles
          WHERE tenant_id=j.tenant_id AND id=a.agent_profile_id FOR SHARE;
        PERFORM 1 FROM crm.contacts WHERE tenant_id=j.tenant_id AND id=c.contact_id FOR SHARE;
        PERFORM 1 FROM public.tenants WHERE id=j.tenant_id FOR SHARE;
        PERFORM 1 FROM messaging.channels WHERE tenant_id=j.tenant_id AND id=c.channel_id FOR SHARE;
        PERFORM 1 FROM crm.contact_channel_identities
          WHERE tenant_id=j.tenant_id AND contact_id=c.contact_id FOR SHARE;
        PERFORM 1 FROM service.tenant_configuration WHERE tenant_id=j.tenant_id FOR SHARE;
        PERFORM 1 FROM public.users WHERE id=c.ai_enabled_by_user_id FOR SHARE;
        PERFORM 1 FROM public.memberships
          WHERE tenant_id=j.tenant_id AND user_id=c.ai_enabled_by_user_id FOR SHARE;
        PERFORM 1 FROM platform.machine_tool_grants
          WHERE tenant_id=j.tenant_id AND principal_id=b.principal_id FOR SHARE;
        PERFORM 1 FROM platform.tenant_feature_entitlements WHERE tenant_id=j.tenant_id FOR SHARE;
        PERFORM 1 FROM platform.tenant_configuration_releases WHERE tenant_id=j.tenant_id FOR SHARE;
        PERFORM 1 FROM automation.tenant_processes WHERE tenant_id=j.tenant_id FOR SHARE;
        PERFORM 1 FROM automation.flow_versions WHERE tenant_id=j.tenant_id
          AND agent_profile_version_id=a.id FOR SHARE;
        PERFORM 1 FROM automation.flow_definitions WHERE tenant_id=j.tenant_id FOR SHARE;
        -- Re-read all predicates after waiting on any of those locks.
        IF NOT EXISTS(SELECT 1 FROM ops.jobs fresh
          JOIN messaging.conversations conversation ON conversation.tenant_id=fresh.tenant_id
            AND conversation.id=c.id
          JOIN messaging.channels channel ON channel.tenant_id=conversation.tenant_id
            AND channel.id=conversation.channel_id AND channel.status='active'
          JOIN crm.contacts contact ON contact.tenant_id=conversation.tenant_id
            AND contact.id=conversation.contact_id AND contact.lifecycle_status='active'
          JOIN public.tenants tenant ON tenant.id=fresh.tenant_id AND tenant.status='active'
          JOIN platform.tenant_ai_execution_bindings binding ON binding.tenant_id=fresh.tenant_id
            AND binding.enabled AND binding.principal_id=b.principal_id
          WHERE fresh.id=j.id AND fresh.status='running' AND fresh.locked_by=p_worker
            AND fresh.claim_token=p_claim AND fresh.lease_expires_at>clock_timestamp()
            AND conversation.ownership_mode='ai' AND conversation.removed_from_inbox_at IS NULL
            AND conversation.ownership_epoch=c.ownership_epoch
            AND conversation.ai_agent_profile_version_id=a.id
            AND conversation.ai_enabled_by_user_id=c.ai_enabled_by_user_id
            AND (fresh.job_type<>'whatsapp.ai.reply' OR (fresh.admitted_agent_version_id=a.id
              AND EXISTS(SELECT 1 FROM agents.messaging_session_admissions admission
                WHERE admission.tenant_id=fresh.tenant_id AND admission.job_id=fresh.id
                  AND admission.agent_version_id=a.id)))
            AND platform.messaging_ai_actor_authorized(conversation.ai_enabled_by_user_id)
            AND platform.machine_agent_tools_authorized(a.id,b.principal_id)
            AND (a.tool_permissions ? p_capability OR (p_capability='lead.read'
              AND a.tool_permissions ?| ARRAY['lead.write','lead.finalize','lead.follow_up']))
            AND EXISTS(SELECT 1 FROM messaging.messages m WHERE m.tenant_id=fresh.tenant_id
              AND m.id=source_message AND m.conversation_id=conversation.id AND
              m.direction='inbound')
            AND (channel.provider<>'meta' OR (contact.whatsapp_consent='granted'
              AND contact.whatsapp_opted_out_at IS NULL AND EXISTS(
                SELECT 1 FROM messaging.inbound_message_origins origin
                  JOIN crm.contact_channel_identities identity ON
                  identity.id=origin.contact_identity_id
                    AND identity.tenant_id=origin.tenant_id AND identity.contact_id=contact.id
                    AND identity.validation_status='valid' AND identity.channel='whatsapp'
                    AND identity.normalized_value=origin.sender_address
                  WHERE origin.tenant_id=fresh.tenant_id AND origin.message_id=source_message)))
            AND (p_capability<>'service.intake' OR EXISTS(SELECT 1 FROM
            service.tenant_configuration config
              WHERE config.tenant_id=fresh.tenant_id AND config.enabled AND
              config.whatsapp_intake_enabled))) THEN
          RAISE EXCEPTION 'machine_tool_denied' USING ERRCODE='42501';
        END IF;
        SELECT m.id INTO latest_message FROM messaging.messages m
          JOIN messaging.channels channel ON channel.id=c.channel_id AND
          channel.tenant_id=c.tenant_id
          LEFT JOIN ops.inbound_events event ON event.tenant_id=m.tenant_id AND
          event.provider=m.provider
            AND event.provider_account_id=channel.provider_account_id
            AND event.payload->>'providerMessageId'=m.provider_message_id
          WHERE m.tenant_id=j.tenant_id AND m.conversation_id=c.id
            AND m.direction='inbound' AND m.content_type<>'event'
          ORDER BY COALESCE(event.received_at,m.created_at) DESC,
            event.receipt_sequence DESC NULLS LAST,m.created_at DESC,m.updated_at DESC,m.id
            DESC LIMIT 1;
        IF latest_message IS DISTINCT FROM source_message THEN
          RAISE EXCEPTION 'machine_tool_source_superseded' USING ERRCODE='42501'; END IF;
        IF EXISTS(SELECT 1 FROM messaging.messages m
          JOIN messaging.channels channel ON channel.id=c.channel_id AND
          channel.tenant_id=c.tenant_id
          JOIN messaging.inbound_message_origins origin ON origin.message_id=m.id
            AND origin.tenant_id=m.tenant_id
          JOIN ops.inbound_events event ON event.tenant_id=m.tenant_id AND event.provider='meta'
            AND event.provider_account_id=channel.provider_account_id
            AND event.payload->>'providerMessageId'=m.provider_message_id
          JOIN ops.inbound_events newer ON newer.tenant_id=event.tenant_id
            AND newer.provider=event.provider AND
            newer.provider_account_id=event.provider_account_id
            AND newer.receipt_sequence>event.receipt_sequence
            AND newer.status IN ('received','processing','failed')
            AND (newer.status='processing' OR newer.attempts<newer.max_attempts)
            AND newer.event_type IN ('whatsapp.message.text','whatsapp.message.image',
              'whatsapp.message.document','whatsapp.message.location','whatsapp.message.audio',
              'whatsapp.message.video','whatsapp.message.interactive')
            AND newer.payload->>'providerMessageId'<>m.provider_message_id
            AND regexp_replace(newer.payload->>'from','[^0-9]','','g')=
              regexp_replace(origin.sender_address,'[^0-9]','','g')
          WHERE m.id=source_message AND m.tenant_id=j.tenant_id AND m.conversation_id=c.id) THEN
          RAISE EXCEPTION 'machine_tool_source_superseded' USING ERRCODE='42501'; END IF;
        SELECT jsonb_build_object('grants',COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'capability',grant_row.capability,'flowVersionId',grant_row.flow_version_id,
            'agentVersionId',grant_row.agent_version_id,'enabled',grant_row.enabled)
            ORDER BY grant_row.capability)
          FROM platform.machine_tool_grants grant_row WHERE grant_row.tenant_id=j.tenant_id
            AND grant_row.principal_id=b.principal_id AND grant_row.agent_version_id=a.id),
            '[]'::jsonb),
          'release',(SELECT jsonb_build_object('id',release.id,'version',release.version,
            'configuration',release.configuration) FROM platform.tenant_configuration_releases
            release
            WHERE release.tenant_id=j.tenant_id AND release.status='published'
            ORDER BY release.version DESC,release.id DESC LIMIT 1)) INTO v_authority_snapshot;
        IF EXISTS(SELECT 1 FROM platform.machine_tool_claims prior
          WHERE prior.tenant_id=j.tenant_id AND prior.job_id=j.id
            AND (prior.principal_id IS DISTINCT FROM b.principal_id
              OR prior.agent_version_id IS DISTINCT FROM a.id
              OR prior.conversation_id IS DISTINCT FROM c.id
              OR prior.contact_id IS DISTINCT FROM c.contact_id
              OR prior.consent_user_id IS DISTINCT FROM c.ai_enabled_by_user_id
              OR prior.source_message_id IS DISTINCT FROM source_message
              OR prior.ownership_epoch IS DISTINCT FROM c.ownership_epoch
              OR prior.authority_snapshot IS DISTINCT FROM v_authority_snapshot)) THEN
          RAISE EXCEPTION 'machine_tool_job_binding_changed' USING ERRCODE='42501'; END IF;
        INSERT INTO platform.machine_tool_claims(tenant_id,job_id,claim_token,principal_id,
          agent_version_id,conversation_id,contact_id,consent_user_id,source_message_id,ownership_epoch,
          authority_snapshot)
        VALUES(j.tenant_id,j.id,p_claim,b.principal_id,a.id,c.id,c.contact_id,
          c.ai_enabled_by_user_id,source_message,c.ownership_epoch,v_authority_snapshot) ON
          CONFLICT DO NOTHING;
        SELECT * INTO retained FROM platform.machine_tool_claims
          WHERE tenant_id=j.tenant_id AND job_id=j.id AND claim_token=p_claim;
        IF retained.principal_id IS DISTINCT FROM b.principal_id
          OR retained.agent_version_id IS DISTINCT FROM a.id
          OR retained.conversation_id IS DISTINCT FROM c.id
          OR retained.contact_id IS DISTINCT FROM c.contact_id
          OR retained.consent_user_id IS DISTINCT FROM c.ai_enabled_by_user_id
          OR retained.source_message_id IS DISTINCT FROM source_message
          OR retained.ownership_epoch IS DISTINCT FROM c.ownership_epoch
          OR retained.authority_snapshot IS DISTINCT FROM v_authority_snapshot THEN
          RAISE EXCEPTION 'machine_tool_claim_binding_changed' USING ERRCODE='42501'; END IF;
        RETURN jsonb_build_object('mode','principal','principalId',b.principal_id,
          'contactId',c.contact_id,'conversationId',c.id,'agentVersionId',a.id,
          'ownershipEpoch',c.ownership_epoch,'consentUserId',c.ai_enabled_by_user_id,
          'sourceMessageId',source_message,'sourceChannel','whatsapp','recordedBy','agent',
          'agentProfileVersionId',a.id,'conversationOwnershipEpoch',c.ownership_epoch);
      END $$""")
    op.execute("""CREATE FUNCTION platform.commit_machine_intake_receipt(
      p_job uuid,p_worker text,p_claim uuid,p_intake uuid) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE authority jsonb; v_operation_key text:='machine-intake:'||p_job::text;
        prior_resource uuid;
      BEGIN
        authority:=platform.authorize_machine_tool(p_job,p_worker,p_claim,'service.intake');
        IF authority->>'mode' IS DISTINCT FROM 'principal' THEN
          RAISE EXCEPTION 'machine_tool_bridge_not_enabled' USING ERRCODE='42501'; END IF;
        PERFORM 1 FROM service.intake_drafts draft
          JOIN service.intake_messages linked ON linked.tenant_id=draft.tenant_id
            AND linked.intake_draft_id=draft.id
          WHERE draft.id=p_intake AND draft.tenant_id=platform.current_tenant_id()
            AND draft.conversation_id=(authority->>'conversationId')::uuid
            AND draft.reporting_contact_id=(authority->>'contactId')::uuid
            AND linked.message_id=(authority->>'sourceMessageId')::uuid FOR UPDATE OF draft;
        IF NOT FOUND THEN RAISE EXCEPTION 'machine_tool_foreign_intake' USING ERRCODE='42501';
        END IF;
        authority:=platform.authorize_machine_tool(p_job,p_worker,p_claim,'service.intake');
        prior_resource:=platform.machine_tool_replay(p_job,v_operation_key,'service.intake',authority);
        IF prior_resource IS NOT NULL AND prior_resource IS DISTINCT FROM p_intake THEN
          RAISE EXCEPTION 'machine_tool_receipt_binding_changed' USING ERRCODE='42501'; END IF;
        INSERT INTO platform.machine_tool_receipts(tenant_id,job_id,operation_key,principal_id,
          capability,agent_version_id,contact_id,conversation_id,consent_user_id,ownership_epoch,resource_id)
        VALUES(platform.current_tenant_id(),p_job,v_operation_key,(authority->>'principalId')::uuid,
          'service.intake',(authority->>'agentVersionId')::uuid,(authority->>'contactId')::uuid,
          (authority->>'conversationId')::uuid,(authority->>'consentUserId')::uuid,
          (authority->>'ownershipEpoch')::bigint,p_intake) ON CONFLICT DO NOTHING;
        IF EXISTS(SELECT 1 FROM platform.machine_tool_receipts
          WHERE tenant_id=platform.current_tenant_id() AND job_id=p_job AND
          platform.machine_tool_receipts.operation_key=v_operation_key
            AND resource_id<>p_intake) THEN
          RAISE EXCEPTION 'machine_tool_receipt_binding_changed' USING ERRCODE='42501'; END IF;
        INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
        SELECT platform.current_tenant_id(),'machine-principal','machine.tool.committed','intake_draft',p_intake,
          jsonb_build_object('principalId',authority->>'principalId',
            'consentUserId',authority->>'consentUserId','jobId',p_job,
            'capability','service.intake','operationKey',v_operation_key)
        WHERE NOT EXISTS(SELECT 1 FROM audit.records WHERE tenant_id=platform.current_tenant_id()
          AND action='machine.tool.committed' AND metadata->>'operationKey'=v_operation_key);
        RETURN jsonb_build_object('resourceId',p_intake,'principalId',authority->>'principalId');
      END $$""")
    op.execute("""CREATE FUNCTION platform.machine_tool_replay(
      p_job uuid,p_key text,p_capability text,p_authority jsonb) RETURNS uuid
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE retained platform.machine_tool_receipts%ROWTYPE;
      BEGIN
        SELECT * INTO retained FROM platform.machine_tool_receipts
          WHERE tenant_id=platform.current_tenant_id() AND job_id=p_job AND operation_key=p_key;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF retained.principal_id IS DISTINCT FROM (p_authority->>'principalId')::uuid
          OR retained.agent_version_id IS DISTINCT FROM (p_authority->>'agentVersionId')::uuid
          OR retained.contact_id IS DISTINCT FROM (p_authority->>'contactId')::uuid
          OR retained.conversation_id IS DISTINCT FROM (p_authority->>'conversationId')::uuid
          OR retained.consent_user_id IS DISTINCT FROM (p_authority->>'consentUserId')::uuid
          OR retained.ownership_epoch IS DISTINCT FROM (p_authority->>'ownershipEpoch')::bigint
          OR retained.capability IS DISTINCT FROM p_capability THEN
          RAISE EXCEPTION 'machine_tool_receipt_binding_changed' USING ERRCODE='42501'; END IF;
        RETURN retained.resource_id;
      END $$""")
    op.execute(
        "REVOKE ALL ON FUNCTION platform.machine_tool_replay(uuid,text,text,jsonb) FROM PUBLIC"
    )
    op.execute("""CREATE FUNCTION platform.machine_lead_tool(
      p_job uuid,p_worker text,p_claim uuid,p_operation text,p_arguments jsonb) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE authority jsonb; capability text; result jsonb; state jsonb;
        bound jsonb; lead_id uuid; schema_id uuid; schema_version integer;
        v_operation_key text; observations jsonb; consent uuid; principal uuid;
      BEGIN
        capability:=CASE p_operation WHEN 'ensure' THEN 'lead.write' WHEN 'read' THEN 'lead.read'
          WHEN 'save' THEN 'lead.write' WHEN 'finalize' THEN 'lead.finalize'
          WHEN 'follow_up' THEN 'lead.follow_up' ELSE NULL END;
        IF capability IS NULL OR jsonb_typeof(p_arguments) IS DISTINCT FROM 'object'
          OR octet_length(p_arguments::text)>65536 THEN
          RAISE EXCEPTION 'machine_tool_invalid_arguments' USING ERRCODE='22023';
        END IF;
        IF p_arguments ?| ARRAY['tenantId','contactId','principalId','actorUserId','capabilities',
          'agentProfileVersionId','conversationId','sourceMessageId','fieldSchemaId'] THEN
          RAISE EXCEPTION 'machine_tool_forged_authority' USING ERRCODE='42501';
        END IF;
        authority:=platform.authorize_machine_tool(p_job,p_worker,p_claim,capability);
        IF authority->>'mode' IS DISTINCT FROM 'principal' THEN
          RAISE EXCEPTION 'machine_tool_bridge_not_enabled' USING ERRCODE='42501';
        END IF;
        -- Human consent is retained as provenance, never runtime execution identity.
        consent:=(authority->>'consentUserId')::uuid;
        principal:=(authority->>'principalId')::uuid;
        bound:=authority-'consentUserId'-'principalId'-'mode';
        SELECT schema.id,schema.version INTO schema_id,schema_version
          FROM agents.agent_profile_versions agent JOIN crm.lead_field_schemas schema
            ON schema.id=(agent.channel_configuration->>'leadFieldSchemaId')::uuid
              AND schema.tenant_id=agent.tenant_id AND schema.published_at IS NOT NULL
          WHERE agent.id=(authority->>'agentVersionId')::uuid
            AND agent.tenant_id=platform.current_tenant_id();
        IF schema_id IS NULL THEN RAISE EXCEPTION 'machine_tool_schema_unavailable'
          USING ERRCODE='42501'; END IF;
        IF p_operation='save' THEN
          SELECT jsonb_agg(value-'observedAt'-'sourceReferenceId') INTO observations
            FROM jsonb_array_elements(p_arguments->'observations');
          v_operation_key:='machine:'||p_job::text||':'||p_operation||':'||md5(observations::text);
        ELSE
          v_operation_key:='machine:'||p_job::text||':'||p_operation||':'||
            md5((p_arguments-'leadId'-'expectedRevision')::text);
        END IF;
        lead_id:=platform.machine_tool_replay(p_job,v_operation_key,capability,authority);
        IF lead_id IS NOT NULL THEN
          IF p_arguments ? 'leadId' AND (p_arguments->>'leadId')::uuid IS DISTINCT FROM lead_id THEN
            RAISE EXCEPTION 'machine_tool_foreign_lead' USING ERRCODE='42501'; END IF;
          result:=platform.lead_operation_receipt(bound,
            CASE WHEN p_operation='ensure' THEN 'machine-create:'||p_job::text ELSE
            v_operation_key END);
          IF result IS NULL OR (result->>'leadId')::uuid IS DISTINCT FROM lead_id THEN
            RAISE EXCEPTION 'machine_tool_receipt_unavailable' USING ERRCODE='42501'; END IF;
          RETURN CASE WHEN p_operation='ensure' THEN
          jsonb_build_object('receipt',result,'created',false)
            ELSE jsonb_build_object('receipt',result,'rejected','[]'::jsonb) END;
        END IF;
        IF p_operation='ensure' THEN
          result:=platform.lead_ensure_for_interaction(bound,'machine-create:'||p_job::text,
            schema_id,schema_version,NULL,NULL,(authority->>'sourceMessageId')::uuid);
          lead_id:=(result->'receipt'->>'leadId')::uuid;
        ELSE
          state:=platform.lead_capture_state(bound,NULL,NULL);
          lead_id:=(state->'lead'->>'id')::uuid;
          IF p_arguments ? 'leadId' AND (p_arguments->>'leadId')::uuid IS DISTINCT FROM lead_id THEN
            RAISE EXCEPTION 'machine_tool_foreign_lead' USING ERRCODE='42501'; END IF;
          IF p_operation='read' THEN RETURN state; END IF;
          IF lead_id IS NULL THEN RAISE EXCEPTION 'machine_tool_lead_unavailable'
            USING ERRCODE='42501'; END IF;
          PERFORM 1 FROM crm.leads WHERE tenant_id=platform.current_tenant_id() AND id=lead_id
          FOR UPDATE;
          -- Lock waits cannot turn an earlier valid claim into lasting permission.
          authority:=platform.authorize_machine_tool(p_job,p_worker,p_claim,capability);
          IF p_operation='save' THEN
            SELECT jsonb_agg(value||jsonb_build_object(
              'sourceReferenceId',authority->>'sourceMessageId',
              'observedAt',(SELECT created_at FROM messaging.messages
                WHERE tenant_id=platform.current_tenant_id()
                  AND id=(authority->>'sourceMessageId')::uuid)))
              INTO observations FROM jsonb_array_elements(p_arguments->'observations');
            result:=platform.lead_save_fields(bound,lead_id,v_operation_key,
              (p_arguments->>'expectedRevision')::integer,observations);
          ELSIF p_operation='finalize' THEN
            result:=platform.lead_finalize(bound,lead_id,v_operation_key,
              (p_arguments->>'expectedRevision')::integer,p_arguments->>'summary',
              p_arguments->>'nextAction');
          ELSE
            result:=platform.lead_request_follow_up(bound,lead_id,v_operation_key,
              p_arguments->>'note',(p_arguments->>'dueAt')::timestamptz);
          END IF;
        END IF;
        authority:=platform.authorize_machine_tool(p_job,p_worker,p_claim,capability);
        INSERT INTO platform.machine_tool_receipts(tenant_id,job_id,operation_key,principal_id,
          capability,agent_version_id,contact_id,conversation_id,consent_user_id,ownership_epoch,resource_id)
        VALUES(platform.current_tenant_id(),p_job,v_operation_key,principal,capability,
          (authority->>'agentVersionId')::uuid,(authority->>'contactId')::uuid,
          (authority->>'conversationId')::uuid,consent,(authority->>'ownershipEpoch')::bigint,lead_id)
        ON CONFLICT DO NOTHING;
        INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
        SELECT platform.current_tenant_id(),'machine-principal','machine.tool.committed','lead',lead_id,
          jsonb_build_object('principalId',principal,'consentUserId',consent,'jobId',p_job,
            'capability',capability,'operationKey',v_operation_key)
        WHERE NOT EXISTS(SELECT 1 FROM audit.records WHERE tenant_id=platform.current_tenant_id()
          AND action='machine.tool.committed' AND metadata->>'operationKey'=v_operation_key);
        RETURN result;
      END $$""")
    op.execute("""CREATE FUNCTION platform.machine_ticket_open(
      p_job uuid,p_worker text,p_claim uuid,p_subject text) RETURNS uuid
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE authority jsonb; ticket_id uuid; created boolean:=false;
        v_operation_key text:='machine-ticket:'||p_job::text;
      BEGIN
        IF length(btrim(p_subject)) NOT BETWEEN 1 AND 240 THEN
          RAISE EXCEPTION 'machine_tool_invalid_arguments' USING ERRCODE='22023'; END IF;
        authority:=platform.authorize_machine_tool(p_job,p_worker,p_claim,'ticket.open');
        IF authority->>'mode' IS DISTINCT FROM 'principal' THEN
          RAISE EXCEPTION 'machine_tool_bridge_not_enabled' USING ERRCODE='42501'; END IF;
        ticket_id:=platform.machine_tool_replay(p_job,v_operation_key,'ticket.open',authority);
        IF ticket_id IS NOT NULL THEN
          PERFORM 1 FROM support.tickets WHERE tenant_id=platform.current_tenant_id() AND
          id=ticket_id
            AND contact_id=(authority->>'contactId')::uuid
            AND source_conversation_id=(authority->>'conversationId')::uuid
            AND EXISTS(SELECT 1 FROM platform.machine_tool_receipts receipt
              WHERE receipt.tenant_id=platform.current_tenant_id() AND receipt.job_id=p_job
                AND receipt.operation_key=v_operation_key
                AND receipt.arguments_digest=md5(btrim(p_subject)));
          IF NOT FOUND THEN RAISE EXCEPTION 'machine_tool_ticket_replay_conflict'
            USING ERRCODE='42501'; END IF;
          RETURN ticket_id;
        END IF;
        SELECT id INTO ticket_id FROM support.tickets
          WHERE tenant_id=platform.current_tenant_id()
            AND source_conversation_id=(authority->>'conversationId')::uuid
            AND contact_id=(authority->>'contactId')::uuid AND status='open'
          ORDER BY last_activity_at DESC,id DESC LIMIT 1 FOR UPDATE;
        authority:=platform.authorize_machine_tool(p_job,p_worker,p_claim,'ticket.open');
        IF ticket_id IS NULL THEN
          INSERT INTO support.tickets(id,tenant_id,reference,attachment_key,contact_id,subject,
            source_channel,source_conversation_id,priority,stage,handling_mode)
          SELECT generated.id,platform.current_tenant_id(),
            'T-'||to_char(CURRENT_TIMESTAMP,'YYYY')||'-'||
              upper(left(replace(generated.id::text,'-',''),8)),v_operation_key,
            (authority->>'contactId')::uuid,btrim(p_subject),'whatsapp',
            (authority->>'conversationId')::uuid,'normal','new','ai_whatsapp'
          FROM (SELECT gen_random_uuid() AS id) generated
          ON CONFLICT ON CONSTRAINT uq_support_tickets_attachment DO NOTHING
          RETURNING id INTO ticket_id;
          created:=FOUND;
          IF ticket_id IS NULL THEN SELECT id INTO ticket_id FROM support.tickets
            WHERE tenant_id=platform.current_tenant_id() AND attachment_key=v_operation_key
              AND contact_id=(authority->>'contactId')::uuid
              AND source_conversation_id=(authority->>'conversationId')::uuid; END IF;
        END IF;
        IF ticket_id IS NULL THEN RAISE EXCEPTION 'machine_tool_ticket_unavailable'
          USING ERRCODE='42501'; END IF;
        authority:=platform.authorize_machine_tool(p_job,p_worker,p_claim,'ticket.open');
        IF created THEN
          WITH allocated AS (UPDATE support.tickets SET next_event_sequence=next_event_sequence+1,
            last_activity_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=platform.current_tenant_id() AND id=ticket_id
            RETURNING id,next_event_sequence AS sequence)
          INSERT INTO support.ticket_events(tenant_id,ticket_id,sequence,kind,actor_kind,
            visibility,summary_safe,evidence)
          SELECT platform.current_tenant_id(),allocated.id,allocated.sequence,'opened','ai',
            'internal','Issue opened from WhatsApp.',jsonb_build_object(
              'principalId',authority->>'principalId','consentUserId',authority->>'consentUserId',
              'jobId',p_job,'attachmentKey',v_operation_key) FROM allocated;
        END IF;
        INSERT INTO platform.machine_tool_receipts(tenant_id,job_id,operation_key,principal_id,
          capability,agent_version_id,contact_id,conversation_id,consent_user_id,ownership_epoch,resource_id,
          arguments_digest)
        VALUES(platform.current_tenant_id(),p_job,v_operation_key,(authority->>'principalId')::uuid,
          'ticket.open',(authority->>'agentVersionId')::uuid,(authority->>'contactId')::uuid,
          (authority->>'conversationId')::uuid,(authority->>'consentUserId')::uuid,
          (authority->>'ownershipEpoch')::bigint,ticket_id,md5(btrim(p_subject))) ON CONFLICT
          DO NOTHING;
        INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
        SELECT platform.current_tenant_id(),'machine-principal','machine.tool.committed','ticket',ticket_id,
          jsonb_build_object('principalId',authority->>'principalId',
            'consentUserId',authority->>'consentUserId','jobId',p_job,
            'capability','ticket.open','operationKey',v_operation_key)
        WHERE NOT EXISTS(SELECT 1 FROM audit.records WHERE tenant_id=platform.current_tenant_id()
          AND action='machine.tool.committed' AND metadata->>'operationKey'=v_operation_key);
        RETURN ticket_id;
      END $$""")
    op.execute("""CREATE FUNCTION platform.machine_tool_source_binding_current(p_job uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      SELECT EXISTS(SELECT 1 FROM platform.machine_tool_claims retained
        JOIN platform.tenant_ai_execution_bindings binding ON binding.tenant_id=retained.tenant_id
          AND binding.enabled AND binding.principal_id=retained.principal_id
        JOIN messaging.conversations conversation ON conversation.tenant_id=retained.tenant_id
          AND conversation.id=retained.conversation_id AND
          conversation.contact_id=retained.contact_id
          AND conversation.ai_agent_profile_version_id=retained.agent_version_id
          AND conversation.ai_enabled_by_user_id=retained.consent_user_id
          AND conversation.ownership_epoch=retained.ownership_epoch AND
          conversation.ownership_mode='ai'
        WHERE retained.tenant_id=platform.current_tenant_id() AND retained.job_id=p_job
          AND retained.authority_snapshot=jsonb_build_object('grants',COALESCE((SELECT jsonb_agg(
            jsonb_build_object('capability',g.capability,'flowVersionId',g.flow_version_id,
              'agentVersionId',g.agent_version_id,'enabled',g.enabled) ORDER BY g.capability)
            FROM platform.machine_tool_grants g WHERE g.tenant_id=retained.tenant_id
              AND g.principal_id=retained.principal_id AND
              g.agent_version_id=retained.agent_version_id),'[]'::jsonb),
            'release',(SELECT
            jsonb_build_object('id',r.id,'version',r.version,'configuration',r.configuration)
              FROM platform.tenant_configuration_releases r WHERE r.tenant_id=retained.tenant_id
                AND r.status='published' ORDER BY r.version DESC,r.id DESC LIMIT 1)))
      $$""")
    op.execute(
        "REVOKE ALL ON FUNCTION platform.machine_tool_source_binding_current(uuid) FROM PUBLIC"
    )
    op.execute("""CREATE FUNCTION platform.machine_ticket_delivery_receipt(p_message uuid,p_ticket uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      SELECT EXISTS(SELECT 1 FROM messaging.outbound_requests request
        JOIN platform.outbound_execution_authority authority
          ON authority.tenant_id=request.tenant_id AND authority.request_id=request.id
        JOIN platform.machine_tool_receipts receipt
          ON receipt.tenant_id=authority.tenant_id AND receipt.job_id=authority.source_job_id
          AND receipt.principal_id=authority.principal_id
          AND receipt.agent_version_id=authority.agent_version_id
          AND receipt.ownership_epoch=authority.ownership_epoch
        JOIN support.tickets ticket ON ticket.tenant_id=receipt.tenant_id AND
        ticket.id=receipt.resource_id
        WHERE request.tenant_id=platform.current_tenant_id() AND request.message_id=p_message
          AND authority.mode='principal' AND receipt.capability='ticket.open'
          AND receipt.resource_id=p_ticket AND ticket.contact_id=receipt.contact_id
          AND ticket.source_conversation_id=receipt.conversation_id)
      $$""")
    for signature in (
        "platform.machine_ticket_delivery_receipt(uuid,uuid)",
        "platform.machine_agent_tools_authorized(uuid,uuid)",
        "platform.authorize_machine_tool(uuid,text,uuid,text)",
        "platform.machine_lead_tool(uuid,text,uuid,text,jsonb)",
        "platform.machine_ticket_open(uuid,text,uuid,text)",
        "platform.commit_machine_intake_receipt(uuid,text,uuid,uuid)",
    ):
        op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")  # noqa: S608
        op.execute(f"GRANT EXECUTE ON FUNCTION {signature} TO platform_messaging")  # noqa: S608
    op.execute("""DO $$ DECLARE body text; anchor text:=
      'ELSIF permissions IS DISTINCT FROM ''[]''::jsonb THEN';
      BEGIN
        SELECT pg_get_functiondef('platform.admit_messaging_execution_principal(uuid,text,uuid)'::regprocedure)
          INTO body;
        IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
          RAISE EXCEPTION 'machine_principal_admission_guard_drift'; END IF;
        EXECUTE replace(body,anchor,
          'ELSIF permissions IS DISTINCT FROM ''[]''::jsonb AND NOT platform.machine_agent_tools_authorized('
          ||'(SELECT c.ai_agent_profile_version_id FROM messaging.conversations c JOIN ops.jobs j '
          ||'ON j.reference_id=c.id AND j.tenant_id=c.tenant_id WHERE j.id=p_job '
          ||'AND j.tenant_id=platform.current_tenant_id()),principal.id) THEN');
      END $$""")
    op.execute("""DO $$ DECLARE body text; anchor text:=
      'to_jsonb(a.tool_permissions)=''[]''::jsonb';
      BEGIN
        SELECT pg_get_functiondef('platform.outbound_execution_authorized(uuid,text,uuid)'::regprocedure)
          INTO body;
        IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
          RAISE EXCEPTION 'machine_outbound_guard_drift'; END IF;
        EXECUTE replace(body,anchor,'('||anchor||
          ' OR (platform.machine_agent_tools_authorized(a.id,retained.principal_id)'
          ||' AND platform.machine_tool_source_binding_current(retained.source_job_id)))');
      END $$""")


def downgrade():
    op.execute("""DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM platform.machine_tool_grants WHERE enabled)
        OR EXISTS(SELECT 1 FROM platform.machine_tool_receipts)
        OR EXISTS(SELECT 1 FROM platform.machine_tool_claims) THEN
        RAISE EXCEPTION 'machine_tool_authority_requires_reviewed_retention';
      END IF;
    END $$""")
    op.execute("""DO $$ DECLARE body text; anchor text:=
      ' OR (platform.machine_agent_tools_authorized(a.id,retained.principal_id)'
      ||' AND platform.machine_tool_source_binding_current(retained.source_job_id))';
      BEGIN
        SELECT pg_get_functiondef('platform.outbound_execution_authorized(uuid,text,uuid)'::regprocedure)
          INTO body;
        IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
          RAISE EXCEPTION 'machine_outbound_guard_drift'; END IF;
        EXECUTE replace(body,'(to_jsonb(a.tool_permissions)=''[]''::jsonb'||anchor||')',
          'to_jsonb(a.tool_permissions)=''[]''::jsonb');
      END $$""")
    op.execute("""DO $$ DECLARE body text; anchor text:=
      'ELSIF permissions IS DISTINCT FROM ''[]''::jsonb AND NOT platform.machine_agent_tools_authorized('
      ||'(SELECT c.ai_agent_profile_version_id FROM messaging.conversations c JOIN ops.jobs j '
      ||'ON j.reference_id=c.id AND j.tenant_id=c.tenant_id WHERE j.id=p_job '
      ||'AND j.tenant_id=platform.current_tenant_id()),principal.id) THEN';
      BEGIN
        SELECT pg_get_functiondef('platform.admit_messaging_execution_principal(uuid,text,uuid)'::regprocedure)
          INTO body;
        IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
          RAISE EXCEPTION 'machine_principal_admission_guard_drift'; END IF;
        EXECUTE replace(body,anchor,'ELSIF permissions IS DISTINCT FROM ''[]''::jsonb THEN');
      END $$""")
    op.execute("DROP FUNCTION platform.machine_lead_tool(uuid,text,uuid,text,jsonb)")
    op.execute("DROP FUNCTION platform.machine_tool_source_binding_current(uuid)")
    op.execute("DROP FUNCTION platform.machine_ticket_delivery_receipt(uuid,uuid)")
    op.execute("DROP FUNCTION platform.machine_ticket_open(uuid,text,uuid,text)")
    op.execute("DROP FUNCTION platform.commit_machine_intake_receipt(uuid,text,uuid,uuid)")
    op.execute("DROP FUNCTION platform.authorize_machine_tool(uuid,text,uuid,text)")
    op.execute("DROP FUNCTION platform.machine_tool_replay(uuid,text,text,jsonb)")
    op.execute("DROP FUNCTION platform.machine_agent_tools_authorized(uuid,uuid)")
    op.execute("DROP TABLE platform.machine_tool_receipts")
    op.execute("DROP TABLE platform.machine_tool_claims")
    op.execute("DROP TABLE platform.machine_tool_grants")
