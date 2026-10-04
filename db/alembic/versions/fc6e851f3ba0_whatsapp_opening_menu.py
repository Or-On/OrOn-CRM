"""Disabled by default, tenant-bound existing-template opening-menu receipts."""

from alembic import op

revision = "fc6e851f3ba0"
down_revision = "fb5d740e2a9f"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(r"""
CREATE TABLE platform.whatsapp_opening_menu_configuration (
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
      channel_id uuid NOT NULL REFERENCES messaging.channels(id) ON DELETE RESTRICT,
      enabled boolean NOT NULL DEFAULT false,
      agent_version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id) ON DELETE
RESTRICT,
      flow_version_id uuid NOT NULL REFERENCES automation.flow_versions(id) ON DELETE
RESTRICT,
      fallback_language text NOT NULL DEFAULT 'he' CHECK(fallback_language IN ('he','en')),
      templates jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(templates)='object'),
      destinations_verified boolean NOT NULL DEFAULT false,
      services_capabilities text[] NOT NULL DEFAULT ARRAY[]::text[]
        CHECK(services_capabilities <@
ARRAY['lead.read','lead.write','lead.finalize','lead.follow_up']),
      support_capabilities text[] NOT NULL DEFAULT ARRAY[]::text[]
        CHECK(support_capabilities <@ ARRAY['ticket.open','service.intake']),
      PRIMARY KEY(tenant_id,channel_id),
      CHECK(NOT enabled OR (destinations_verified AND templates ?& ARRAY['he','en']
        AND cardinality(services_capabilities)>0 AND cardinality(support_capabilities)>0))
    );
""")
    op.execute(r"""
CREATE TABLE platform.whatsapp_opening_menu_state (
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
      conversation_id uuid NOT NULL REFERENCES messaging.conversations(id) ON DELETE
RESTRICT,
      ownership_epoch bigint NOT NULL,
      preferred_language text CHECK(preferred_language IN ('he','en')),
      route_intent text CHECK(route_intent IN ('services','support')),
      generation uuid,
      offer_source_message_id uuid REFERENCES messaging.messages(id) ON DELETE RESTRICT,
      offer_job_id uuid REFERENCES ops.jobs(id) ON DELETE RESTRICT,
      offered_at timestamptz,
      last_receipt_sequence bigint,
      last_activity_at timestamptz,
      status text NOT NULL DEFAULT 'new' CHECK(status IN
('new','pending','sending','sent','failed','unknown','chosen','blocked')),
      provider_message_id text,
      plan jsonb,
      PRIMARY KEY(tenant_id,conversation_id)
    );
""")
    op.execute(r"""
CREATE TABLE platform.whatsapp_opening_menu_operations (
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
      job_id uuid NOT NULL REFERENCES ops.jobs(id) ON DELETE RESTRICT,
      source_message_id uuid NOT NULL REFERENCES messaging.messages(id) ON DELETE RESTRICT,
      conversation_id uuid NOT NULL REFERENCES messaging.conversations(id) ON DELETE
RESTRICT,
      ownership_epoch bigint NOT NULL,
      configuration_snapshot jsonb NOT NULL,
      decision jsonb NOT NULL,
      attempt_claim_token uuid,
      attempt_worker text,
      outcome text CHECK(outcome IN ('sent','failed','unknown')),
      outcome_provider_message_id text,
      PRIMARY KEY(tenant_id,job_id)
    );
""")
    op.execute(r"""
CREATE TABLE platform.whatsapp_opening_menu_business_claims (
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
      job_id uuid NOT NULL REFERENCES ops.jobs(id) ON DELETE RESTRICT,
      conversation_id uuid NOT NULL REFERENCES messaging.conversations(id) ON DELETE
RESTRICT,
      mode text NOT NULL CHECK(mode IN ('off','chosen')),
      ownership_epoch bigint,
      generation uuid,
      configuration_snapshot jsonb NOT NULL,
      PRIMARY KEY(tenant_id,job_id),
      CHECK((mode='off' AND ownership_epoch IS NULL AND generation IS NULL)
        OR (mode='chosen' AND ownership_epoch IS NOT NULL AND generation IS NOT NULL))
    );
""")
    op.execute(r"""
ALTER TABLE platform.whatsapp_opening_menu_business_claims ENABLE ROW LEVEL SECURITY;
""")
    op.execute(r"""
ALTER TABLE platform.whatsapp_opening_menu_business_claims FORCE ROW LEVEL SECURITY;
""")
    op.execute(r"""
CREATE POLICY opening_menu_business_claim_tenant ON
platform.whatsapp_opening_menu_business_claims
      USING(tenant_id=platform.current_tenant_id()) WITH
CHECK(tenant_id=platform.current_tenant_id());
""")
    op.execute(r"""
GRANT SELECT,INSERT,UPDATE,DELETE ON platform.whatsapp_opening_menu_business_claims TO
platform_migrator;
""")
    op.execute(r"""
ALTER TABLE platform.whatsapp_opening_menu_configuration ENABLE ROW LEVEL SECURITY;
""")
    op.execute(r"""
ALTER TABLE platform.whatsapp_opening_menu_configuration FORCE ROW LEVEL SECURITY;
""")
    op.execute(r"""
ALTER TABLE platform.whatsapp_opening_menu_state ENABLE ROW LEVEL SECURITY;
""")
    op.execute(r"""
ALTER TABLE platform.whatsapp_opening_menu_state FORCE ROW LEVEL SECURITY;
""")
    op.execute(r"""
ALTER TABLE platform.whatsapp_opening_menu_operations ENABLE ROW LEVEL SECURITY;
""")
    op.execute(r"""
ALTER TABLE platform.whatsapp_opening_menu_operations FORCE ROW LEVEL SECURITY;
""")
    op.execute(r"""
CREATE POLICY opening_menu_configuration_tenant ON
platform.whatsapp_opening_menu_configuration
      USING(tenant_id=platform.current_tenant_id()) WITH
CHECK(tenant_id=platform.current_tenant_id());
""")
    op.execute(r"""
CREATE POLICY opening_menu_state_tenant ON platform.whatsapp_opening_menu_state
      USING(tenant_id=platform.current_tenant_id()) WITH
CHECK(tenant_id=platform.current_tenant_id());
""")
    op.execute(r"""
CREATE POLICY opening_menu_operations_tenant ON platform.whatsapp_opening_menu_operations
      USING(tenant_id=platform.current_tenant_id()) WITH
CHECK(tenant_id=platform.current_tenant_id());
""")
    op.execute(r"""
GRANT SELECT,INSERT,UPDATE,DELETE ON platform.whatsapp_opening_menu_configuration,
      platform.whatsapp_opening_menu_state,platform.whatsapp_opening_menu_operations TO
platform_migrator;
""")
    op.execute(r"""
CREATE FUNCTION platform.opening_menu_scope(p_job uuid,p_worker text,p_claim uuid) RETURNS
jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE j ops.jobs%ROWTYPE; c messaging.conversations%ROWTYPE;
      cfg platform.whatsapp_opening_menu_configuration%ROWTYPE;
      m messaging.messages%ROWTYPE; ch messaging.channels%ROWTYPE;
      event ops.inbound_events%ROWTYPE;
    BEGIN
      SELECT * INTO j FROM ops.jobs WHERE tenant_id=platform.current_tenant_id() AND
id=p_job
        AND queue='messaging' AND job_type IN
('whatsapp.ai.reply','whatsapp.opening_menu','field_service.intake.extract')
        AND status='running' AND locked_by=p_worker AND claim_token=p_claim
        AND lease_expires_at>clock_timestamp() FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'opening_menu_stale_claim' USING ERRCODE='42501';
END IF;
      SELECT * INTO c FROM messaging.conversations WHERE tenant_id=j.tenant_id AND id=CASE
WHEN j.job_type='field_service.intake.extract' THEN
          (SELECT conversation_id FROM messaging.messages WHERE tenant_id=j.tenant_id AND
id=j.reference_id)
          ELSE j.reference_id END FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'opening_menu_conversation_unavailable' USING
ERRCODE='42501'; END IF;
      SELECT * INTO cfg FROM platform.whatsapp_opening_menu_configuration
        WHERE tenant_id=j.tenant_id AND channel_id=c.channel_id FOR SHARE;
      IF NOT FOUND OR NOT cfg.enabled THEN RETURN jsonb_build_object('kind','disabled'); END
IF;
      SELECT * INTO ch FROM messaging.channels WHERE tenant_id=j.tenant_id AND
id=c.channel_id
        AND provider='meta' AND status='active' FOR SHARE;
      SELECT * INTO m FROM messaging.messages WHERE tenant_id=j.tenant_id AND
conversation_id=c.id
        AND id=CASE WHEN j.job_type='field_service.intake.extract' THEN j.reference_id ELSE
(j.payload->>'triggerMessageId')::uuid END AND provider='meta' AND direction='inbound' FOR
SHARE;
      PERFORM 1 FROM public.tenants WHERE id=j.tenant_id AND status='active' FOR SHARE;
      IF NOT FOUND THEN RETURN
jsonb_build_object('kind','blocked','reason','tenant-inactive'); END IF;
      PERFORM 1 FROM platform.tenant_ai_execution_bindings WHERE tenant_id=j.tenant_id FOR
SHARE;
      PERFORM 1 FROM platform.ai_execution_principals WHERE tenant_id=j.tenant_id FOR SHARE;
      PERFORM 1 FROM platform.machine_tool_grants WHERE tenant_id=j.tenant_id FOR SHARE;
      PERFORM 1 FROM platform.tenant_feature_entitlements WHERE tenant_id=j.tenant_id FOR
SHARE;
      PERFORM 1 FROM platform.tenant_configuration_releases WHERE tenant_id=j.tenant_id FOR
SHARE;
      PERFORM 1 FROM automation.flow_versions WHERE tenant_id=j.tenant_id AND
id=cfg.flow_version_id FOR SHARE;
      PERFORM 1 FROM automation.flow_definitions WHERE tenant_id=j.tenant_id FOR SHARE;
      PERFORM 1 FROM automation.tenant_processes WHERE tenant_id=j.tenant_id FOR SHARE;
      PERFORM 1 FROM agents.agent_profile_versions a JOIN agents.agent_profiles profile
        ON profile.tenant_id=a.tenant_id AND profile.id=a.agent_profile_id
        WHERE a.tenant_id=j.tenant_id AND a.id=cfg.agent_version_id AND profile.archived_at
IS NULL
          AND a.published_at IS NOT NULL AND a.validation_status='valid' FOR SHARE OF
a,profile;
      IF NOT FOUND THEN RETURN
jsonb_build_object('kind','blocked','reason','agent-unavailable'); END IF;
      IF m.id IS NULL OR ch.id IS NULL OR c.ownership_mode<>'ai' OR c.removed_from_inbox_at
IS NOT NULL
        OR c.ai_agent_profile_version_id IS DISTINCT FROM cfg.agent_version_id
        OR NOT cfg.destinations_verified OR NOT
platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
        OR NOT EXISTS(SELECT 1 FROM platform.tenant_ai_execution_bindings binding
          WHERE binding.tenant_id=j.tenant_id AND binding.enabled
            AND
platform.machine_agent_tools_authorized(cfg.agent_version_id,binding.principal_id)
            AND NOT EXISTS(SELECT 1 FROM
unnest(cfg.services_capabilities||cfg.support_capabilities) capability
              WHERE NOT EXISTS(SELECT 1 FROM platform.machine_tool_grants grant_row
                WHERE grant_row.tenant_id=j.tenant_id AND
grant_row.principal_id=binding.principal_id
                  AND grant_row.agent_version_id=cfg.agent_version_id AND
grant_row.flow_version_id=cfg.flow_version_id
                  AND grant_row.capability=capability AND grant_row.enabled)))
        OR NOT platform.current_tenant_feature_enabled('whatsapp')
        OR NOT
platform.approved_flow_for_channel(cfg.flow_version_id,cfg.agent_version_id,'whatsapp') THEN
        RETURN
jsonb_build_object('kind','blocked','reason','canonical-binding-unavailable'); END IF;
      PERFORM 1 FROM crm.contacts contact JOIN messaging.inbound_message_origins origin
          ON origin.tenant_id=contact.tenant_id AND origin.contact_identity_id IS NOT NULL
        JOIN crm.contact_channel_identities identity ON identity.tenant_id=origin.tenant_id
          AND identity.id=origin.contact_identity_id AND identity.contact_id=contact.id
          AND identity.channel='whatsapp' AND identity.validation_status='valid'
          AND identity.normalized_value=origin.sender_address
        WHERE contact.tenant_id=j.tenant_id AND contact.id=c.contact_id
          AND contact.lifecycle_status='active' AND contact.whatsapp_consent='granted'
          AND contact.whatsapp_opted_out_at IS NULL AND origin.message_id=m.id FOR SHARE OF
contact,identity;
      IF NOT FOUND THEN RETURN
jsonb_build_object('kind','blocked','reason','recipient-not-authorized'); END IF;
      SELECT * INTO event FROM ops.inbound_events WHERE tenant_id=j.tenant_id AND
provider='meta'
        AND provider_account_id=ch.provider_account_id AND
payload->>'providerMessageId'=m.provider_message_id
        ORDER BY receipt_sequence LIMIT 1 FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'opening_menu_source_missing' USING ERRCODE='42501';
END IF;
      IF NOT EXISTS(SELECT 1 FROM ops.jobs fresh WHERE fresh.id=j.id AND
fresh.tenant_id=j.tenant_id
        AND fresh.status='running' AND fresh.locked_by=p_worker AND
fresh.claim_token=p_claim
        AND fresh.lease_expires_at>clock_timestamp()) THEN
        RAISE EXCEPTION 'opening_menu_stale_claim' USING ERRCODE='42501'; END IF;
      RETURN jsonb_build_object('kind','scope','tenantId',j.tenant_id,'conversationId',c.id,
       
'channelId',ch.id,'ownershipEpoch',c.ownership_epoch,'agentVersionId',cfg.agent_version_id,
       
'flowVersionId',cfg.flow_version_id,'sourceMessageId',m.id,'configuration',to_jsonb(cfg),
        'receiptSequence',event.receipt_sequence,'receivedAt',event.received_at,
        'text',m.content_text,'buttonPayload',event.payload#>>'{interaction,id}',
        'replyToProviderMessageId',event.payload->>'replyToProviderMessageId',
        'phoneNumberId',ch.provider_account_id,'wabaId',ch.configuration->>'wabaId',
        'graphApiVersion',ch.configuration->>'graphApiVersion',
        'recipient',(SELECT sender_address FROM messaging.inbound_message_origins WHERE
tenant_id=j.tenant_id AND message_id=m.id));
    END $$;
""")
    op.execute(r"""
CREATE FUNCTION platform.prepare_opening_menu(p_job uuid,p_worker text,p_claim uuid) RETURNS
jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE scope jsonb; cfg jsonb; prior platform.whatsapp_opening_menu_operations%ROWTYPE;
      s platform.whatsapp_opening_menu_state%ROWTYPE; decision jsonb; language text;
      previous_activity timestamptz; received timestamptz; sequence bigint; button text;
intent text;
      template jsonb; v_generation uuid; reopened boolean;
    BEGIN
      scope:=platform.opening_menu_scope(p_job,p_worker,p_claim);
      IF scope->>'kind'<>'scope' THEN RETURN scope; END IF;
      cfg:=scope->'configuration';
      SELECT * INTO prior FROM platform.whatsapp_opening_menu_operations
        WHERE tenant_id=platform.current_tenant_id() AND job_id=p_job;
      IF FOUND THEN
        IF prior.outcome IN ('sent','unknown') THEN
          RETURN jsonb_build_object('kind','handled','reason','retained-physical-outcome');
END IF;
        IF prior.source_message_id IS DISTINCT FROM (scope->>'sourceMessageId')::uuid
          OR prior.conversation_id IS DISTINCT FROM (scope->>'conversationId')::uuid
          OR prior.ownership_epoch IS DISTINCT FROM (scope->>'ownershipEpoch')::bigint
          OR prior.configuration_snapshot IS DISTINCT FROM cfg
          OR (prior.decision->>'kind'='offer' AND (prior.decision->>'channelId' IS DISTINCT
FROM scope->>'channelId'
            OR prior.decision->>'phoneNumberId' IS DISTINCT FROM scope->>'phoneNumberId'
            OR prior.decision->>'wabaId' IS DISTINCT FROM scope->>'wabaId'
            OR prior.decision->>'graphApiVersion' IS DISTINCT FROM scope->>'graphApiVersion'
            OR prior.decision->>'recipient' IS DISTINCT FROM scope->>'recipient')) THEN
          RAISE EXCEPTION 'opening_menu_operation_binding_changed' USING ERRCODE='42501';
END IF;
        SELECT * INTO s FROM platform.whatsapp_opening_menu_state WHERE
tenant_id=prior.tenant_id
          AND conversation_id=prior.conversation_id FOR UPDATE;
        IF prior.decision->>'kind'='offer' AND s.status IN
('sending','unknown','sent','chosen') THEN
          RETURN jsonb_build_object('kind','handled','reason','offer-already-attempted');
END IF;
        RETURN prior.decision;
      END IF;
      INSERT INTO
platform.whatsapp_opening_menu_state(tenant_id,conversation_id,ownership_epoch)
       
VALUES(platform.current_tenant_id(),(scope->>'conversationId')::uuid,(scope->>'ownershipEpoch')::bigint)
        ON CONFLICT DO NOTHING;
      SELECT * INTO s FROM platform.whatsapp_opening_menu_state WHERE
tenant_id=platform.current_tenant_id()
        AND conversation_id=(scope->>'conversationId')::uuid FOR UPDATE;
      received:=(scope->>'receivedAt')::timestamptz;
sequence:=(scope->>'receiptSequence')::bigint;
      IF s.ownership_epoch IS DISTINCT FROM (scope->>'ownershipEpoch')::bigint THEN
       
-- A takeover invalidates the prior menu/choice; opening again requires a new AI-owned job.
        UPDATE platform.whatsapp_opening_menu_state SET
ownership_epoch=(scope->>'ownershipEpoch')::bigint,
          route_intent=NULL,generation=NULL,status='new',plan=NULL,provider_message_id=NULL
          WHERE tenant_id=s.tenant_id AND conversation_id=s.conversation_id;
       
s.route_intent:=NULL;s.generation:=NULL;s.status:='new';s.plan:=NULL;s.provider_message_id:=NULL;
      END IF;
      SELECT operation.decision INTO decision FROM platform.whatsapp_opening_menu_operations
operation
        WHERE operation.tenant_id=s.tenant_id AND
operation.conversation_id=s.conversation_id
          AND operation.source_message_id=(scope->>'sourceMessageId')::uuid
          AND operation.ownership_epoch=(scope->>'ownershipEpoch')::bigint
          AND operation.configuration_snapshot=cfg AND operation.decision->>'kind'='route'
          AND sequence=s.last_receipt_sequence AND s.status='chosen'
          AND operation.decision->>'generation'=s.generation::text LIMIT 1;
      IF FOUND THEN NULL;
-- Same canonical message's AI/extract jobs share its settled choice.
      ELSIF sequence<=COALESCE(s.last_receipt_sequence,0) OR
received<COALESCE(s.last_activity_at,received) THEN
        decision:=jsonb_build_object('kind','handled','reason','duplicate-or-delayed');
      ELSE
        SELECT max(event.received_at) INTO previous_activity FROM messaging.messages message
          JOIN messaging.channels channel ON channel.tenant_id=message.tenant_id AND
channel.id=(scope->>'channelId')::uuid
          JOIN ops.inbound_events event ON event.tenant_id=message.tenant_id AND
event.provider='meta'
            AND event.provider_account_id=channel.provider_account_id AND
event.payload->>'providerMessageId'=message.provider_message_id
          WHERE message.tenant_id=s.tenant_id AND message.conversation_id=s.conversation_id
            AND message.direction='inbound' AND event.receipt_sequence<sequence AND
message.content_type<>'event';
        previous_activity:=GREATEST(previous_activity,s.last_activity_at);
        reopened:=previous_activity IS NULL OR received-previous_activity>=interval
'24 hours';
        button:=scope->>'buttonPayload';
        IF button IS NOT NULL THEN
          IF NOT reopened AND s.status='sent' AND s.route_intent IS NULL
            AND s.provider_message_id=scope->>'replyToProviderMessageId'
            AND button IN
('oron.menu.'||s.generation::text||'.services','oron.menu.'||s.generation::text||'.support')
THEN
            intent:=CASE WHEN button='oron.menu.'||s.generation::text||'.services' THEN
'services' ELSE 'support' END;
            UPDATE platform.whatsapp_opening_menu_state SET
route_intent=intent,status='chosen',
              preferred_language=plan->>'language' WHERE tenant_id=s.tenant_id AND
conversation_id=s.conversation_id;
           
decision:=jsonb_build_object('kind','route','intent',intent,'language',s.plan->>'language','generation',s.generation,
             
'agentVersionId',scope->>'agentVersionId','flowVersionId',scope->>'flowVersionId',
              'allowedCapabilities',cfg->CASE WHEN intent='services' THEN
'services_capabilities' ELSE 'support_capabilities' END);
          ELSE
decision:=jsonb_build_object('kind','handled','reason','stale-or-unbound-button'); END IF;
        ELSIF NOT reopened AND s.route_intent IS NOT NULL THEN
         
decision:=jsonb_build_object('kind','route','intent',s.route_intent,'language',s.preferred_language,'generation',s.generation,
           
'agentVersionId',scope->>'agentVersionId','flowVersionId',scope->>'flowVersionId',
            'allowedCapabilities',cfg->CASE WHEN s.route_intent='services' THEN
'services_capabilities' ELSE 'support_capabilities' END);
        ELSIF NOT reopened AND s.status IN
('pending','sending','sent','failed','unknown','blocked') THEN
          decision:=jsonb_build_object('kind','handled','reason','awaiting-choice');
        ELSIF NOT reopened THEN
decision:=jsonb_build_object('kind','blocked','reason','existing-conversation-awaits-opening-boundary');
        ELSE
          language:=COALESCE(s.preferred_language,CASE
            WHEN COALESCE(scope->>'text','') ~ '[\u05d0-\u05ea]' THEN 'he'
            WHEN COALESCE(scope->>'text','') ~ '[A-Za-z]{3}' THEN 'en'
            ELSE cfg->>'fallback_language' END);
          template:=cfg->'templates'->language;
          IF template->>'status' IS DISTINCT FROM 'APPROVED' OR template->>'name' IS NULL
            OR template->>'language' IS DISTINCT FROM language
            OR COALESCE(template->>'servicesButtonText','')='' OR
COALESCE(template->>'supportButtonText','')=''
            OR template->>'servicesButtonIndex' IS NULL OR template->>'supportButtonIndex'
IS NULL
            OR template->>'servicesButtonIndex'=template->>'supportButtonIndex' THEN
           
decision:=jsonb_build_object('kind','blocked','reason','approved-template-unavailable');
          ELSE
            v_generation:=gen_random_uuid();
           
decision:=scope||jsonb_build_object('kind','offer','generation',v_generation,'language',language,
              'template',template,'operationKey','opening-menu:'||v_generation::text,
              'servicesPayload','oron.menu.'||v_generation::text||'.services',
              'supportPayload','oron.menu.'||v_generation::text||'.support');
            UPDATE platform.whatsapp_opening_menu_state SET
generation=v_generation,offer_job_id=p_job,
              offer_source_message_id=(scope->>'sourceMessageId')::uuid,offered_at=received,
              route_intent=NULL,status='pending',provider_message_id=NULL,plan=decision
              WHERE tenant_id=s.tenant_id AND conversation_id=s.conversation_id;
          END IF;
        END IF;
        UPDATE platform.whatsapp_opening_menu_state SET
last_receipt_sequence=sequence,last_activity_at=received
          WHERE tenant_id=s.tenant_id AND conversation_id=s.conversation_id;
      END IF;
      INSERT INTO
platform.whatsapp_opening_menu_operations(tenant_id,job_id,source_message_id,
        conversation_id,ownership_epoch,configuration_snapshot,decision)
        VALUES(s.tenant_id,p_job,(scope->>'sourceMessageId')::uuid,s.conversation_id,
          (scope->>'ownershipEpoch')::bigint,cfg,decision);
      RETURN decision;
    END $$;
""")
    op.execute(r"""
CREATE FUNCTION platform.begin_opening_menu_attempt(p_job uuid,p_worker text,p_claim uuid)
RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE scope jsonb; operation platform.whatsapp_opening_menu_operations%ROWTYPE;
    BEGIN
      scope:=platform.opening_menu_scope(p_job,p_worker,p_claim);
      SELECT * INTO operation FROM platform.whatsapp_opening_menu_operations
        WHERE tenant_id=platform.current_tenant_id() AND job_id=p_job FOR UPDATE;
      IF NOT FOUND OR operation.decision->>'kind'<>'offer' OR scope->>'kind'<>'scope'
        OR operation.configuration_snapshot IS DISTINCT FROM scope->'configuration'
        OR operation.ownership_epoch IS DISTINCT FROM (scope->>'ownershipEpoch')::bigint
        OR operation.source_message_id IS DISTINCT FROM (scope->>'sourceMessageId')::uuid
THEN
        RAISE EXCEPTION 'opening_menu_attempt_denied' USING ERRCODE='42501'; END IF;
      UPDATE platform.whatsapp_opening_menu_state SET status='sending'
        WHERE tenant_id=operation.tenant_id AND conversation_id=operation.conversation_id
          AND generation=(operation.decision->>'generation')::uuid AND status IN
('pending','failed');
      IF NOT FOUND THEN RAISE EXCEPTION 'opening_menu_attempt_already_started' USING
ERRCODE='42501'; END IF;
INSERT INTO messaging.messages
  (id,tenant_id,conversation_id,direction,sender_type,sender_user_id,
   content_type,content_text,structured_content,provider,status)
VALUES
  ((operation.decision->>'generation')::uuid,operation.tenant_id,operation.conversation_id,
   'outbound','system',NULL,'template',NULL,
   jsonb_build_object('templateName',operation.decision#>>'{template,name}',
     'language',operation.decision->>'language','parameters','[]'::jsonb,
     'openingMenuGeneration',operation.decision->>'generation',
     'openingMenuOutcome','sending',
     'buttons',jsonb_build_array(operation.decision#>>'{template,servicesButtonText}',
       operation.decision#>>'{template,supportButtonText}')),
   'meta','queued')
ON CONFLICT(id) DO NOTHING;
PERFORM 1 FROM messaging.messages
WHERE id=(operation.decision->>'generation')::uuid AND tenant_id=operation.tenant_id
  AND conversation_id=operation.conversation_id AND direction='outbound'
  AND sender_type='system' AND sender_user_id IS NULL AND content_type='template'
  AND provider='meta'
  AND structured_content->>'openingMenuGeneration'=operation.decision->>'generation'
  AND structured_content->>'templateName'=operation.decision#>>'{template,name}'
  AND structured_content->>'language'=operation.decision->>'language'
  AND structured_content->'parameters'='[]'::jsonb
  AND
structured_content->'buttons'=jsonb_build_array(operation.decision#>>'{template,servicesButtonText}',operation.decision#>>'{template,supportButtonText}');
IF NOT FOUND THEN RAISE EXCEPTION 'opening_menu_history_binding_changed' USING
ERRCODE='42501'; END IF;
UPDATE messaging.messages SET status='queued',updated_at=clock_timestamp(),
  structured_content=jsonb_set(structured_content,'{openingMenuOutcome}','"sending"'::jsonb)
WHERE id=(operation.decision->>'generation')::uuid AND tenant_id=operation.tenant_id
  AND status IN ('queued','sending','failed');


      UPDATE platform.whatsapp_opening_menu_operations SET attempt_claim_token=p_claim,
        attempt_worker=p_worker,outcome=NULL,outcome_provider_message_id=NULL
        WHERE tenant_id=operation.tenant_id AND job_id=p_job;
      RETURN operation.decision;
    END $$;
""")
    op.execute(r"""
CREATE FUNCTION platform.settle_opening_menu_attempt(p_job uuid,p_worker text,p_claim
uuid,p_outcome text,p_provider_message text)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE j ops.jobs%ROWTYPE; operation platform.whatsapp_opening_menu_operations%ROWTYPE;
    BEGIN
      IF p_outcome NOT IN ('sent','failed','unknown') OR (p_outcome='sent' AND
(p_provider_message IS NULL
        OR length(p_provider_message) NOT BETWEEN 1 AND 1000)) THEN
        RAISE EXCEPTION 'opening_menu_invalid_settlement' USING ERRCODE='22023'; END IF;
      SELECT * INTO operation FROM platform.whatsapp_opening_menu_operations
        WHERE tenant_id=platform.current_tenant_id() AND job_id=p_job FOR UPDATE;
      IF NOT FOUND OR operation.attempt_claim_token IS DISTINCT FROM p_claim
        OR operation.attempt_worker IS DISTINCT FROM p_worker OR operation.outcome IS NOT
NULL THEN
        RAISE EXCEPTION 'opening_menu_stale_settlement' USING ERRCODE='42501'; END IF;
      SELECT * INTO j FROM ops.jobs WHERE tenant_id=operation.tenant_id AND id=p_job;
      UPDATE platform.whatsapp_opening_menu_operations SET outcome=p_outcome,
        outcome_provider_message_id=p_provider_message WHERE tenant_id=j.tenant_id AND
job_id=p_job;
UPDATE messaging.messages SET
  provider_message_id=CASE WHEN p_outcome='sent' THEN p_provider_message ELSE
provider_message_id END,
  status=CASE WHEN status IN ('delivered','read') THEN status
    WHEN p_outcome='sent' THEN 'sent' WHEN p_outcome='failed' THEN 'failed' ELSE 'queued'
END,
 
structured_content=jsonb_set(structured_content,'{openingMenuOutcome}',to_jsonb(p_outcome)),
  updated_at=clock_timestamp()
WHERE id=(operation.decision->>'generation')::uuid AND tenant_id=operation.tenant_id
  AND conversation_id=operation.conversation_id AND direction='outbound' AND
sender_type='system'
  AND sender_user_id IS NULL AND content_type='template' AND provider='meta'
  AND structured_content->>'openingMenuGeneration'=operation.decision->>'generation';
IF NOT FOUND THEN RAISE EXCEPTION 'opening_menu_history_missing' USING ERRCODE='42501'; END
IF;
UPDATE messaging.conversations SET updated_at=clock_timestamp()
WHERE tenant_id=operation.tenant_id AND id=operation.conversation_id;

      UPDATE platform.whatsapp_opening_menu_state SET
status=p_outcome,provider_message_id=p_provider_message
        WHERE tenant_id=j.tenant_id AND conversation_id=operation.conversation_id
          AND generation=(operation.decision->>'generation')::uuid AND status='sending';
      -- Physical outcome survives takeover/new epoch; never mutate a newer generation.
      INSERT INTO
audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
       
VALUES(j.tenant_id,'opening-menu','whatsapp.opening_menu.'||p_outcome,'conversation',operation.conversation_id,
         
jsonb_build_object('jobId',j.id,'generation',operation.decision->>'generation','providerMessageId',p_provider_message));
    END $$;
""")
    op.execute(r"""
CREATE FUNCTION platform.opening_menu_attempt_authorized(p_job uuid,p_worker text,p_claim
uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE scope jsonb;
    BEGIN
      scope:=platform.opening_menu_scope(p_job,p_worker,p_claim);
      RETURN scope->>'kind'='scope' AND EXISTS(SELECT 1 FROM
platform.whatsapp_opening_menu_operations operation
        JOIN platform.whatsapp_opening_menu_state state ON
state.tenant_id=operation.tenant_id
          AND state.conversation_id=operation.conversation_id
        WHERE operation.tenant_id=platform.current_tenant_id() AND operation.job_id=p_job
          AND operation.source_message_id=(scope->>'sourceMessageId')::uuid
          AND operation.ownership_epoch=(scope->>'ownershipEpoch')::bigint
          AND operation.configuration_snapshot=scope->'configuration'
          AND operation.decision->>'channelId'=scope->>'channelId'
          AND operation.decision->>'phoneNumberId'=scope->>'phoneNumberId'
          AND operation.decision->>'wabaId'=scope->>'wabaId'
          AND operation.decision->>'graphApiVersion'=scope->>'graphApiVersion'
          AND operation.decision->>'recipient'=scope->>'recipient'
          AND state.generation=(operation.decision->>'generation')::uuid AND
state.status='sending');
    END $$;
""")
    op.execute(r"""
CREATE FUNCTION platform.opening_menu_channel_credential(p_job uuid,p_worker text,p_claim
uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE scope jsonb; credential jsonb;
    BEGIN
      scope:=platform.opening_menu_scope(p_job,p_worker,p_claim);
      IF scope->>'kind'<>'scope' THEN RAISE EXCEPTION 'opening_menu_credential_denied' USING
ERRCODE='42501'; END IF;
      SELECT CASE WHEN channel.credential_id IS NULL THEN jsonb_build_object('legacy',true)
        ELSE jsonb_build_object('tenantId',channel.tenant_id,'channelId',channel.id,
         
'credentialId',channel.credential_id,'kind',record.kind,'algorithm',record.algorithm,
         
'keyVersion',record.key_version,'ciphertext',encode(record.ciphertext,'hex'),
'nonce',encode(record.nonce,'hex')) END
        INTO credential FROM platform.whatsapp_opening_menu_operations operation
        JOIN platform.whatsapp_opening_menu_state state ON
state.tenant_id=operation.tenant_id
          AND state.conversation_id=operation.conversation_id
        JOIN messaging.channels channel ON channel.tenant_id=operation.tenant_id
          AND channel.id=(scope->>'channelId')::uuid
        LEFT JOIN platform.credential_records record ON record.tenant_id=channel.tenant_id
AND record.id=channel.credential_id
        WHERE operation.tenant_id=platform.current_tenant_id() AND operation.job_id=p_job
          AND operation.source_message_id=(scope->>'sourceMessageId')::uuid
          AND operation.ownership_epoch=(scope->>'ownershipEpoch')::bigint
          AND operation.configuration_snapshot=scope->'configuration'
          AND operation.decision->>'channelId'=scope->>'channelId'
          AND operation.decision->>'phoneNumberId'=scope->>'phoneNumberId'
          AND operation.decision->>'wabaId'=scope->>'wabaId'
          AND operation.decision->>'graphApiVersion'=scope->>'graphApiVersion'
          AND operation.decision->>'recipient'=scope->>'recipient'
          AND state.generation=(operation.decision->>'generation')::uuid
          AND state.status IN ('pending','failed','sending');
      IF credential IS NULL THEN RAISE EXCEPTION 'opening_menu_credential_denied' USING
ERRCODE='42501'; END IF;
      RETURN credential;
    END $$;
""")
    op.execute(r"""
CREATE FUNCTION platform.opening_menu_tool_allowed(p_conversation uuid,p_capability text)
RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
      SELECT NOT EXISTS(SELECT 1 FROM platform.whatsapp_opening_menu_configuration cfg
        JOIN messaging.conversations c ON c.tenant_id=cfg.tenant_id AND
c.channel_id=cfg.channel_id
        WHERE cfg.tenant_id=platform.current_tenant_id() AND c.id=p_conversation AND
cfg.enabled)
      OR EXISTS(SELECT 1 FROM platform.whatsapp_opening_menu_configuration cfg
        JOIN messaging.conversations c ON c.tenant_id=cfg.tenant_id AND
c.channel_id=cfg.channel_id
        JOIN platform.whatsapp_opening_menu_state state ON state.tenant_id=c.tenant_id AND
state.conversation_id=c.id
        WHERE cfg.tenant_id=platform.current_tenant_id() AND c.id=p_conversation AND
cfg.enabled
          AND cfg.destinations_verified AND
c.ai_agent_profile_version_id=cfg.agent_version_id
          AND
platform.approved_flow_for_channel(cfg.flow_version_id,cfg.agent_version_id,'whatsapp')
          AND state.ownership_epoch=c.ownership_epoch AND state.status='chosen'
          AND ((state.route_intent='services' AND
p_capability=ANY(cfg.services_capabilities))
            OR (state.route_intent='support' AND
p_capability=ANY(cfg.support_capabilities))))
    $$;
""")
    op.execute(r"""
CREATE FUNCTION platform.enqueue_opening_menu_for_inbound(p_message uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE added integer;
    BEGIN
      INSERT INTO
ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority)
      SELECT
message.tenant_id,'messaging','whatsapp.opening_menu','conversation',conversation.id,
        jsonb_build_object('conversationId',conversation.id,'triggerMessageId',message.id),
        'opening-menu:inbound:'||message.id::text,4,110
      FROM messaging.messages message JOIN messaging.conversations conversation
        ON conversation.tenant_id=message.tenant_id AND
conversation.id=message.conversation_id
      JOIN messaging.channels channel ON channel.tenant_id=conversation.tenant_id AND
channel.id=conversation.channel_id
      JOIN platform.whatsapp_opening_menu_configuration cfg ON
cfg.tenant_id=channel.tenant_id AND cfg.channel_id=channel.id AND cfg.enabled
      WHERE message.tenant_id=platform.current_tenant_id() AND message.id=p_message AND
message.direction='inbound'
        AND message.provider='meta' AND message.content_type<>'event' AND
channel.provider='meta' AND channel.status='active'
        AND conversation.ownership_mode='ai' AND conversation.removed_from_inbox_at IS NULL
        AND conversation.ai_agent_profile_version_id=cfg.agent_version_id AND
cfg.destinations_verified
        AND platform.messaging_ai_actor_authorized(conversation.ai_enabled_by_user_id)
        AND platform.current_tenant_feature_enabled('whatsapp')
        AND
platform.approved_flow_for_channel(cfg.flow_version_id,cfg.agent_version_id,'whatsapp')
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS added=ROW_COUNT;RETURN added=1;
    END $$;
""")
    op.execute(r"""
REVOKE ALL ON FUNCTION platform.enqueue_opening_menu_for_inbound(uuid) FROM PUBLIC;
""")
    op.execute(r"""
GRANT EXECUTE ON FUNCTION platform.enqueue_opening_menu_for_inbound(uuid) TO
platform_messaging;
""")
    op.execute(r"""
CREATE FUNCTION platform.opening_menu_business_generation_bound(p_job uuid,p_conversation
uuid,p_mode text,p_epoch bigint,p_generation uuid,p_configuration jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE retained platform.whatsapp_opening_menu_business_claims%ROWTYPE;
    BEGIN
      INSERT INTO
platform.whatsapp_opening_menu_business_claims(tenant_id,job_id,conversation_id,mode,ownership_epoch,generation,configuration_snapshot)
       
VALUES(platform.current_tenant_id(),p_job,p_conversation,p_mode,p_epoch,
p_generation,p_configuration) ON CONFLICT DO NOTHING;
      SELECT * INTO retained FROM platform.whatsapp_opening_menu_business_claims WHERE
tenant_id=platform.current_tenant_id() AND job_id=p_job FOR UPDATE;
      RETURN retained.conversation_id=p_conversation AND retained.mode=p_mode
        AND retained.ownership_epoch IS NOT DISTINCT FROM p_epoch AND retained.generation IS
NOT DISTINCT FROM p_generation
        AND retained.configuration_snapshot=p_configuration;
    END $$;
""")
    op.execute(r"""
REVOKE ALL ON FUNCTION
platform.opening_menu_business_generation_bound(uuid,uuid,text,bigint,uuid,jsonb) FROM
PUBLIC;
""")
    op.execute(r"""
CREATE FUNCTION platform.opening_menu_business_job_allowed(p_job uuid,p_worker text,p_claim
uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE j ops.jobs%ROWTYPE; c messaging.conversations%ROWTYPE; cfg
platform.whatsapp_opening_menu_configuration%ROWTYPE;
      source_job uuid; sender_kind text; source_conversation uuid; human_ocr boolean;
summary_kind text; menu_state platform.whatsapp_opening_menu_state%ROWTYPE; generation_bound
boolean;
    BEGIN
      SELECT * INTO j FROM ops.jobs WHERE tenant_id=platform.current_tenant_id() AND
id=p_job
        AND status='running' AND locked_by=p_worker AND claim_token=p_claim AND
lease_expires_at>clock_timestamp() FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'opening_menu_stale_business_claim' USING
ERRCODE='42501'; END IF;
      IF j.job_type='whatsapp.ai.call' AND j.reference_type='conversation' THEN
source_conversation:=j.reference_id;
      ELSIF j.job_type='whatsapp.outbound.send' THEN
        SELECT request.conversation_id,message.sender_type,authority.source_job_id INTO
source_conversation,sender_kind,source_job
          FROM messaging.outbound_requests request JOIN messaging.messages message
            ON message.tenant_id=request.tenant_id AND message.id=request.message_id
          LEFT JOIN platform.outbound_execution_authority authority ON
authority.tenant_id=request.tenant_id AND authority.request_id=request.id
          WHERE request.tenant_id=j.tenant_id AND request.id=j.reference_id;
        IF sender_kind='user' THEN RETURN EXISTS(SELECT 1 FROM ops.jobs fresh WHERE
fresh.tenant_id=j.tenant_id AND fresh.id=j.id AND fresh.status='running' AND
fresh.locked_by=p_worker AND fresh.claim_token=p_claim AND
fresh.lease_expires_at>clock_timestamp()); END IF;
-- Existing human outbound authority still validates later.
      ELSIF j.job_type='field_service.ocr' THEN
        SELECT message.conversation_id,attachment.created_by_user_id IS NOT NULL INTO
source_conversation,human_ocr
          FROM service.ocr_results result JOIN service.report_attachments attachment
            ON attachment.tenant_id=result.tenant_id AND attachment.id=result.attachment_id
          LEFT JOIN messaging.messages message ON message.tenant_id=attachment.tenant_id AND
message.id=attachment.message_id
          WHERE result.tenant_id=j.tenant_id AND result.id=j.reference_id;
        IF human_ocr THEN RETURN EXISTS(SELECT 1 FROM ops.jobs fresh WHERE
fresh.tenant_id=j.tenant_id AND fresh.id=j.id AND fresh.status='running' AND
fresh.locked_by=p_worker AND fresh.claim_token=p_claim AND
fresh.lease_expires_at>clock_timestamp()); END IF;
-- Existing canonical origin actor checks still required.
      ELSIF j.job_type='field_service.summary' AND j.reference_type='case_summary' THEN
        SELECT source_kind,source_reference_id INTO summary_kind,source_conversation FROM
service.case_summaries
          WHERE tenant_id=j.tenant_id AND id=j.reference_id FOR SHARE;
        IF NOT FOUND THEN RETURN false; END IF;
        IF summary_kind='call' THEN RETURN EXISTS(SELECT 1 FROM ops.jobs fresh WHERE
fresh.tenant_id=j.tenant_id AND fresh.id=j.id AND fresh.status='running' AND
fresh.locked_by=p_worker AND fresh.claim_token=p_claim AND
fresh.lease_expires_at>clock_timestamp()); END IF;
        IF summary_kind<>'whatsapp' THEN RETURN false; END IF;
      ELSIF j.job_type IN ('field_service.photo_request','field_service.intake_followup')
THEN
        SELECT conversation_id INTO source_conversation FROM service.intake_drafts WHERE
tenant_id=j.tenant_id AND id=j.reference_id;
      ELSE RAISE EXCEPTION 'opening_menu_business_job_unsupported' USING ERRCODE='42501';
END IF;
      IF source_conversation IS NULL AND j.job_type='field_service.intake_followup'
        AND j.reference_type='intake_draft' THEN
        IF NOT EXISTS(
          SELECT 1 FROM service.intake_drafts draft
          JOIN public.sessions session ON session.tenant_id=draft.tenant_id
            AND session.session_id=draft.source_session_id
          WHERE draft.tenant_id=j.tenant_id AND draft.id=j.reference_id
            AND draft.conversation_id IS NULL AND draft.followup_status='queued'
            AND session.status='ended'
            AND session.contact_id=COALESCE(draft.customer_contact_id,draft.reporting_contact_id)
        ) THEN RETURN false; END IF;
        IF EXISTS(SELECT 1 FROM platform.whatsapp_opening_menu_configuration
          WHERE tenant_id=j.tenant_id AND enabled) THEN RETURN false; END IF;
        RETURN EXISTS(SELECT 1 FROM ops.jobs fresh
          WHERE fresh.tenant_id=j.tenant_id AND fresh.id=j.id AND fresh.status='running'
            AND fresh.locked_by=p_worker AND fresh.claim_token=p_claim
            AND fresh.lease_expires_at>clock_timestamp());
      END IF;
      SELECT * INTO c FROM messaging.conversations WHERE tenant_id=j.tenant_id AND
id=source_conversation FOR SHARE;
      IF NOT FOUND THEN RETURN false; END IF;
      SELECT * INTO cfg FROM platform.whatsapp_opening_menu_configuration WHERE
tenant_id=j.tenant_id AND channel_id=c.channel_id FOR SHARE;
      IF NOT FOUND OR NOT cfg.enabled THEN
        IF NOT EXISTS(SELECT 1 FROM ops.jobs fresh WHERE fresh.tenant_id=j.tenant_id AND
fresh.id=j.id AND fresh.status='running' AND fresh.locked_by=p_worker AND
fresh.claim_token=p_claim AND fresh.lease_expires_at>clock_timestamp()) THEN RETURN false;
END IF;
       
generation_bound:=platform.opening_menu_business_generation_bound(j.id,c.id,'off',NULL,NULL,'{}');
        RETURN generation_bound AND EXISTS(SELECT 1 FROM ops.jobs fresh WHERE
fresh.tenant_id=j.tenant_id AND fresh.id=j.id AND fresh.status='running' AND
fresh.locked_by=p_worker AND fresh.claim_token=p_claim AND
fresh.lease_expires_at>clock_timestamp()); END IF;
      IF j.job_type='whatsapp.ai.call' THEN RETURN false; END IF;
-- No approved callback capability exists in either branch.
      IF c.ownership_mode<>'ai' OR c.removed_from_inbox_at IS NOT NULL OR
c.ai_agent_profile_version_id IS DISTINCT FROM cfg.agent_version_id
        OR NOT cfg.destinations_verified OR NOT
platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
        OR NOT EXISTS(SELECT 1 FROM platform.tenant_ai_execution_bindings binding WHERE
binding.tenant_id=j.tenant_id AND binding.enabled
          AND
platform.machine_agent_tools_authorized(cfg.agent_version_id,binding.principal_id)
          AND NOT EXISTS(SELECT 1 FROM
unnest(cfg.services_capabilities||cfg.support_capabilities) capability
            WHERE NOT EXISTS(SELECT 1 FROM platform.machine_tool_grants grant_row WHERE
grant_row.tenant_id=j.tenant_id
              AND grant_row.principal_id=binding.principal_id AND
grant_row.agent_version_id=cfg.agent_version_id
              AND grant_row.flow_version_id=cfg.flow_version_id AND
grant_row.capability=capability AND grant_row.enabled))) THEN RETURN false; END IF;
      SELECT * INTO menu_state FROM platform.whatsapp_opening_menu_state WHERE
tenant_id=j.tenant_id AND conversation_id=c.id FOR SHARE;
      IF NOT FOUND OR menu_state.status<>'chosen' OR
menu_state.ownership_epoch<>c.ownership_epoch THEN RETURN false; END IF;
      IF NOT EXISTS(SELECT 1 FROM ops.jobs fresh WHERE fresh.tenant_id=j.tenant_id AND
fresh.id=j.id AND fresh.status='running' AND fresh.locked_by=p_worker AND
fresh.claim_token=p_claim AND fresh.lease_expires_at>clock_timestamp()) THEN RETURN false;
END IF;
     
generation_bound:=platform.opening_menu_business_generation_bound(j.id,c.id,'chosen',c.ownership_epoch,menu_state.generation,to_jsonb(cfg));
      IF NOT generation_bound THEN RETURN false; END IF;
      IF j.job_type='whatsapp.outbound.send' THEN
        RETURN sender_kind='agent' AND EXISTS(SELECT 1 FROM
platform.whatsapp_opening_menu_operations operation
          JOIN platform.whatsapp_opening_menu_state state ON
state.tenant_id=operation.tenant_id AND state.conversation_id=operation.conversation_id
          WHERE operation.tenant_id=j.tenant_id AND operation.job_id=source_job AND
operation.conversation_id=c.id
            AND operation.ownership_epoch=c.ownership_epoch AND
operation.configuration_snapshot=to_jsonb(cfg)
            AND operation.decision->>'kind'='route' AND
operation.decision->>'intent'=state.route_intent
            AND operation.decision->>'generation'=state.generation::text
            AND state.ownership_epoch=c.ownership_epoch AND state.status='chosen') AND
EXISTS(SELECT 1 FROM ops.jobs fresh WHERE fresh.tenant_id=j.tenant_id AND fresh.id=j.id AND
fresh.status='running' AND fresh.locked_by=p_worker AND fresh.claim_token=p_claim AND
fresh.lease_expires_at>clock_timestamp());
      END IF;
      RETURN platform.opening_menu_tool_allowed(c.id,'service.intake') AND EXISTS(SELECT 1
FROM ops.jobs fresh WHERE fresh.tenant_id=j.tenant_id AND fresh.id=j.id AND
fresh.status='running' AND fresh.locked_by=p_worker AND fresh.claim_token=p_claim AND
fresh.lease_expires_at>clock_timestamp());
    END $$;
""")
    op.execute(r"""
REVOKE ALL ON FUNCTION platform.opening_menu_business_job_allowed(uuid,text,uuid) FROM
PUBLIC;
""")
    op.execute(r"""
GRANT EXECUTE ON FUNCTION platform.opening_menu_business_job_allowed(uuid,text,uuid) TO
platform_messaging;
""")
    op.execute(r"""
REVOKE ALL ON FUNCTION platform.opening_menu_scope(uuid,text,uuid) FROM PUBLIC;
""")
    op.execute(r"""
REVOKE ALL ON FUNCTION platform.prepare_opening_menu(uuid,text,uuid) FROM PUBLIC;
""")
    op.execute(r"""
REVOKE ALL ON FUNCTION platform.begin_opening_menu_attempt(uuid,text,uuid) FROM PUBLIC;
""")
    op.execute(r"""
REVOKE ALL ON FUNCTION platform.settle_opening_menu_attempt(uuid,text,uuid,text,text) FROM
PUBLIC;
""")
    op.execute(r"""
REVOKE ALL ON FUNCTION platform.opening_menu_attempt_authorized(uuid,text,uuid) FROM PUBLIC;
""")
    op.execute(r"""
REVOKE ALL ON FUNCTION platform.opening_menu_tool_allowed(uuid,text) FROM PUBLIC;
""")
    op.execute(r"""
REVOKE ALL ON FUNCTION platform.opening_menu_channel_credential(uuid,text,uuid) FROM PUBLIC;
""")
    op.execute(r"""
GRANT EXECUTE ON FUNCTION platform.prepare_opening_menu(uuid,text,uuid),
     
platform.begin_opening_menu_attempt(uuid,text,uuid),platform.settle_opening_menu_attempt(uuid,text,uuid,text,text),
      platform.opening_menu_attempt_authorized(uuid,text,uuid)
      TO platform_messaging;
""")
    op.execute(r"""
GRANT EXECUTE ON FUNCTION platform.opening_menu_channel_credential(uuid,text,uuid) TO
platform_messaging;
""")
    op.execute(r"""
DO $$ DECLARE body text; anchor text:=
      'AND platform.machine_agent_tools_authorized(a.id,b.principal_id)'; BEGIN
      SELECT
pg_get_functiondef('platform.authorize_machine_tool(uuid,text,uuid,text)'::regprocedure)
INTO body;
      IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
        RAISE EXCEPTION 'opening_menu_tool_guard_drift'; END IF;
      EXECUTE
replace(body,anchor,
anchor||' AND platform.opening_menu_tool_allowed(conversation.id,p_capability)');
    END $$
""")


def downgrade():
    op.execute(r"""
DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM platform.whatsapp_opening_menu_state)
        OR EXISTS(SELECT 1 FROM platform.whatsapp_opening_menu_operations)
        OR EXISTS(SELECT 1 FROM platform.whatsapp_opening_menu_business_claims)
        OR EXISTS(SELECT 1 FROM platform.whatsapp_opening_menu_configuration WHERE enabled)
THEN
        RAISE EXCEPTION 'opening_menu_evidence_requires_reviewed_retention'; END IF;
    END $$
""")
    op.execute(r"""
DO $$ DECLARE body text; anchor text:=
      ' AND platform.opening_menu_tool_allowed(conversation.id,p_capability)'; BEGIN
      SELECT
pg_get_functiondef('platform.authorize_machine_tool(uuid,text,uuid,text)'::regprocedure)
INTO body;
      IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
        RAISE EXCEPTION 'opening_menu_tool_guard_drift'; END IF;
      EXECUTE replace(body,anchor,''); END $$
""")
    op.execute(r"""
DROP FUNCTION
platform.opening_menu_business_generation_bound(uuid,uuid,text,bigint,uuid,jsonb)
""")
    op.execute(r"""
DROP FUNCTION platform.enqueue_opening_menu_for_inbound(uuid)
""")
    op.execute(r"""
DROP FUNCTION platform.opening_menu_business_job_allowed(uuid,text,uuid)
""")
    op.execute(r"""
DROP FUNCTION platform.opening_menu_tool_allowed(uuid,text)
""")
    op.execute(r"""
DROP FUNCTION platform.opening_menu_channel_credential(uuid,text,uuid)
""")
    op.execute(r"""
DROP FUNCTION platform.opening_menu_attempt_authorized(uuid,text,uuid)
""")
    op.execute(r"""
DROP FUNCTION platform.settle_opening_menu_attempt(uuid,text,uuid,text,text)
""")
    op.execute(r"""
DROP FUNCTION platform.begin_opening_menu_attempt(uuid,text,uuid)
""")
    op.execute(r"""
DROP FUNCTION platform.prepare_opening_menu(uuid,text,uuid)
""")
    op.execute(r"""
DROP FUNCTION platform.opening_menu_scope(uuid,text,uuid)
""")
    op.execute(r"""
DROP TABLE platform.whatsapp_opening_menu_business_claims
""")
    op.execute(r"""
DROP TABLE platform.whatsapp_opening_menu_operations
""")
    op.execute(r"""
DROP TABLE platform.whatsapp_opening_menu_state
""")
    op.execute(r"""
DROP TABLE platform.whatsapp_opening_menu_configuration
""")
