"""Review and publish tenant feature and workflow packages atomically.

Revision ID: c7e29a1b5d40
Revises: a6d30b9f4c12
"""

# ruff: noqa: E501, S608 -- SQL interpolation uses migration-owned constants only.
import re
from collections.abc import Sequence

from alembic import op

revision: str = "c7e29a1b5d40"
down_revision: str | None = "a6d30b9f4c12"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _execute(script: str) -> None:
    """Send one statement per asyncpg prepare, preserving quoted function bodies."""
    statement = ""
    for index, chunk in enumerate(re.split(r"(\$\$.*?\$\$|'(?:''|[^'])*')", script, flags=re.S)):
        if index % 2:
            statement += chunk
            continue
        fragments = chunk.split(";")
        for fragment in fragments[:-1]:
            statement += fragment
            if statement.strip():
                op.execute(statement)
            statement = ""
        statement += fragments[-1]
    if statement.strip():
        op.execute(statement)


def upgrade() -> None:
    _execute("""
        CREATE TABLE platform.tenant_configuration_releases (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          version integer NOT NULL CHECK(version>0),
          revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
          status text NOT NULL CHECK(status IN ('draft','submitted','published','rejected')),
          configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=131072),
          created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          submitted_at timestamptz,
          approved_at timestamptz,
          approved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          review_notes text CHECK(length(review_notes)<=2000),
          activation_xid bigint,
          UNIQUE(tenant_id,id), UNIQUE(tenant_id,version)
        );
        CREATE UNIQUE INDEX uq_tenant_configuration_pending
          ON platform.tenant_configuration_releases(tenant_id) WHERE status IN ('draft','submitted');
        ALTER TABLE platform.tenant_configuration_releases ENABLE ROW LEVEL SECURITY;
        ALTER TABLE platform.tenant_configuration_releases FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_configuration_scope ON platform.tenant_configuration_releases
          USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
        GRANT SELECT ON platform.tenant_configuration_releases TO platform_web,platform_readonly;
    """)
    # A baseline is an explicit record of the existing setup, not a replacement
    # template. Running customers retain their data, routes and published agents.
    _execute("""
        INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,approved_at,review_notes)
        SELECT tenant.id,1,'published',jsonb_build_object(
          'schemaVersion',1,'templateKey',NULL,
          'features',coalesce((SELECT jsonb_agg(feature.feature_key ORDER BY feature.feature_key)
            FROM platform.tenant_feature_entitlements feature WHERE feature.tenant_id=tenant.id AND feature.enabled),'["contacts"]'::jsonb),
          'featureConfiguration',coalesce((SELECT jsonb_object_agg(feature.feature_key,feature.configuration)
            FROM platform.tenant_feature_entitlements feature WHERE feature.tenant_id=tenant.id),'{}'::jsonb),
          'processes',coalesce((SELECT jsonb_agg(jsonb_build_object(
            'name',process.name,'purpose',process.purpose,'enabled',process.enabled,'trigger',process.trigger_key,
            'channel',process.channel,'businessObject',process.business_object_type,
            'agentProfileVersionId',process.agent_profile_version_id,'flowVersionId',process.flow_version_id,
            'requiredFeatures',process.required_features,'priority',process.priority) ORDER BY process.priority,process.id)
            FROM automation.tenant_processes process WHERE process.tenant_id=tenant.id),'[]'::jsonb)
        ),CURRENT_TIMESTAMP,'Existing configuration preserved during platform upgrade'
        FROM public.tenants tenant WHERE tenant.status<>'deleted';
    """)
    _execute("""
        CREATE FUNCTION platform.configuration_actor_authorized(p_approve boolean DEFAULT false)
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT EXISTS(SELECT 1 FROM public.users actor
            JOIN public.tenants tenant ON tenant.id=platform.current_tenant_id()
            LEFT JOIN public.memberships membership ON membership.tenant_id=tenant.id AND membership.user_id=actor.id
            WHERE actor.id=platform.current_user_id() AND actor.status='active' AND tenant.status='active'
              AND (actor.is_superuser OR (NOT p_approve AND membership.role IN ('owner','admin'))))
        $$;
        REVOKE ALL ON FUNCTION platform.configuration_actor_authorized(boolean) FROM PUBLIC;
    """)
    _execute("""
        CREATE FUNCTION platform.validate_tenant_configuration(p_configuration jsonb,p_validate_bindings boolean DEFAULT true)
        RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_features text[]; v_feature text; v_dependency text; v_process jsonb;
          v_agent agents.agent_profile_versions%ROWTYPE; v_flow automation.flow_versions%ROWTYPE;
          v_channel text; v_required text; v_capability text; v_configuration jsonb;
        BEGIN
          IF p_configuration IS NULL OR jsonb_typeof(p_configuration) IS DISTINCT FROM 'object'
            OR p_configuration->>'schemaVersion' IS DISTINCT FROM '1' OR octet_length(p_configuration::text)>131072
            OR jsonb_typeof(p_configuration->'features') IS DISTINCT FROM 'array'
            OR jsonb_typeof(p_configuration->'processes') IS DISTINCT FROM 'array'
            OR jsonb_typeof(p_configuration->'featureConfiguration') IS DISTINCT FROM 'object'
            OR jsonb_array_length(p_configuration->'features')>14
            OR jsonb_array_length(p_configuration->'processes')>50 THEN
            RAISE EXCEPTION 'invalid configuration package' USING ERRCODE='22023';
          END IF;
          SELECT array_agg(value) INTO v_features FROM jsonb_array_elements_text(p_configuration->'features');
          IF NOT coalesce('contacts'=ANY(v_features),false) OR NOT (v_features <@ ARRAY[
            'contacts','agents','whatsapp','voice','leads','pipeline','tickets','field_service','technicians',
            'documents','ocr','reports','appointments','billing']::text[]) THEN
            RAISE EXCEPTION 'invalid module selection' USING ERRCODE='22023';
          END IF;
          SELECT feature,dependency INTO v_feature,v_dependency FROM (VALUES
            ('whatsapp','contacts'),('voice','contacts'),('voice','agents'),('leads','contacts'),
            ('pipeline','contacts'),('tickets','contacts'),('field_service','contacts'),
            ('technicians','field_service'),('ocr','documents'),('reports','contacts'),('appointments','contacts')
          ) graph(feature,dependency) WHERE feature=ANY(v_features) AND NOT dependency=ANY(v_features) LIMIT 1;
          IF v_feature IS NOT NULL THEN RAISE EXCEPTION 'module % requires %',v_feature,v_dependency USING ERRCODE='TF409'; END IF;
          FOR v_feature,v_configuration IN SELECT key,value FROM jsonb_each(p_configuration->'featureConfiguration') LOOP
            IF NOT v_feature=ANY(ARRAY['contacts','agents','whatsapp','voice','leads','pipeline','tickets','field_service','technicians','documents','ocr','reports','appointments','billing'])
              OR jsonb_typeof(v_configuration)<>'object' OR octet_length(v_configuration::text)>16384 THEN
              RAISE EXCEPTION 'invalid module configuration' USING ERRCODE='22023';
            END IF;
            IF v_feature='field_service' AND v_configuration ? 'workflow' THEN
              IF (v_configuration-'workflow')<>'{}'::jsonb OR NOT service.validate_workflow_policy(v_configuration->'workflow') THEN
                RAISE EXCEPTION 'invalid service workflow policy' USING ERRCODE='22023';
              END IF;
            ELSIF v_configuration<>'{}'::jsonb THEN
              RAISE EXCEPTION 'module does not support these configuration fields' USING ERRCODE='22023';
            END IF;
          END LOOP;
          IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_configuration->'processes') a
            JOIN jsonb_array_elements(p_configuration->'processes') b ON a.value<>b.value
            WHERE (a.value->>'enabled')::boolean AND (b.value->>'enabled')::boolean
              AND a.value->>'trigger'=b.value->>'trigger'
              AND coalesce((a.value->>'priority')::integer,100)=coalesce((b.value->>'priority')::integer,100)
              AND (a.value->>'channel'=b.value->>'channel' OR a.value->>'channel' IS NULL OR b.value->>'channel' IS NULL))
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_configuration->'processes') item
              GROUP BY item->>'name' HAVING count(*)>1) THEN
            RAISE EXCEPTION 'ambiguous or duplicate processes' USING ERRCODE='TF409';
          END IF;
          FOR v_process IN SELECT value FROM jsonb_array_elements(p_configuration->'processes') LOOP
            IF coalesce(length(btrim(v_process->>'name')),0) NOT BETWEEN 1 AND 120
              OR jsonb_typeof(v_process->'enabled')<>'boolean'
              OR v_process->>'trigger' NOT IN ('whatsapp.new_conversation','whatsapp.message','voice.inbound','voice.outbound_assignment','manual.contact_action','lead.new','service_case.created')
              OR (v_process->>'channel' IS NOT NULL AND v_process->>'channel' NOT IN ('whatsapp','voice','manual'))
              OR coalesce((v_process->>'priority')::integer,100) NOT BETWEEN 0 AND 10000 THEN
              RAISE EXCEPTION 'invalid process' USING ERRCODE='22023';
            END IF;
            IF NOT p_validate_bindings OR NOT (v_process->>'enabled')::boolean THEN CONTINUE; END IF;
            SELECT * INTO v_agent FROM agents.agent_profile_versions
              WHERE id=(v_process->>'agentProfileVersionId')::uuid AND tenant_id=platform.current_tenant_id()
              AND published_at IS NOT NULL AND validation_status='valid';
            SELECT * INTO v_flow FROM automation.flow_versions
              WHERE id=(v_process->>'flowVersionId')::uuid AND tenant_id=platform.current_tenant_id()
              AND published_at IS NOT NULL AND validation_status='valid';
            IF v_agent.id IS NULL OR v_flow.id IS NULL OR
              (v_flow.agent_profile_version_id IS NOT NULL AND v_flow.agent_profile_version_id<>v_agent.id)
              OR EXISTS(SELECT 1 FROM agents.agent_profiles WHERE id=v_agent.agent_profile_id AND archived_at IS NOT NULL)
              OR EXISTS(SELECT 1 FROM automation.flow_definitions WHERE id=v_flow.flow_definition_id AND archived_at IS NOT NULL) THEN
              RAISE EXCEPTION 'process requires compatible published versions' USING ERRCODE='TF409';
            END IF;
            v_channel := CASE WHEN v_process->>'trigger' LIKE 'whatsapp.%' THEN 'whatsapp'
              WHEN v_process->>'trigger' LIKE 'voice.%' THEN 'voice' ELSE v_process->>'channel' END;
            IF v_channel IS NOT NULL AND v_process->>'channel' IS NOT NULL AND v_channel<>v_process->>'channel' THEN
              RAISE EXCEPTION 'process channel conflicts with trigger' USING ERRCODE='22023';
            END IF;
            IF v_channel IN ('voice','whatsapp') AND (NOT v_channel=ANY(v_features)
              OR NOT v_channel=ANY(v_agent.channel_capabilities)
              OR NOT EXISTS(SELECT 1 FROM automation.flow_definitions WHERE id=v_flow.flow_definition_id AND v_channel=ANY(channel_capabilities))) THEN
              RAISE EXCEPTION 'process channel is unavailable' USING ERRCODE='TF409';
            END IF;
            IF NOT 'agents'=ANY(v_features) THEN RAISE EXCEPTION 'process requires agents' USING ERRCODE='TF409'; END IF;
            v_required := CASE v_process->>'businessObject' WHEN 'lead' THEN 'leads' WHEN 'deal' THEN 'pipeline'
              WHEN 'ticket' THEN 'tickets' WHEN 'service_case' THEN 'field_service' WHEN 'appointment' THEN 'appointments'
              WHEN 'document' THEN 'documents' ELSE 'contacts' END;
            IF NOT v_required=ANY(v_features) THEN RAISE EXCEPTION 'process business object is disabled' USING ERRCODE='TF409'; END IF;
            FOR v_required IN SELECT jsonb_array_elements_text(coalesce(v_process->'requiredFeatures','[]'::jsonb)) LOOP
              IF NOT v_required=ANY(v_features) THEN RAISE EXCEPTION 'required module is disabled' USING ERRCODE='TF409'; END IF;
            END LOOP;
            FOR v_capability IN SELECT jsonb_array_elements_text(v_agent.tool_permissions) LOOP
              v_required := CASE WHEN v_capability LIKE 'lead.%' THEN 'leads'
                WHEN v_capability='ticket.open' THEN 'tickets' WHEN v_capability='service.intake' THEN 'field_service' ELSE NULL END;
              IF v_required IS NOT NULL AND NOT v_required=ANY(v_features) THEN
                RAISE EXCEPTION 'agent capability requires disabled module' USING ERRCODE='TF409';
              END IF;
              IF v_capability='service.intake' AND NOT 'tickets'=ANY(v_features) THEN
                RAISE EXCEPTION 'service intake requires tickets' USING ERRCODE='TF409';
              END IF;
              IF v_capability='service.intake' AND v_channel='voice'
                AND (p_configuration#>'{featureConfiguration,field_service,workflow,requiredIntakeFields}' IS NULL
                  OR p_configuration#>'{featureConfiguration,field_service,workflow,requiredIntakeFields}' ? 'nationalId') THEN
                RAISE EXCEPTION 'voice service intake requires a workflow without nationalId' USING ERRCODE='TF409';
              END IF;
            END LOOP;
          END LOOP;
        END $$;
        REVOKE ALL ON FUNCTION platform.validate_tenant_configuration(jsonb,boolean) FROM PUBLIC;
    """)
    _execute("""
        CREATE FUNCTION platform.save_tenant_configuration_draft(p_configuration jsonb,p_expected_revision integer,p_request_id text)
        RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_tenant uuid:=platform.current_tenant_id(); v_pending platform.tenant_configuration_releases%ROWTYPE; v_id uuid;
        BEGIN
          IF NOT platform.configuration_actor_authorized(false) THEN RAISE EXCEPTION 'configuration management denied' USING ERRCODE='42501'; END IF;
          PERFORM pg_advisory_xact_lock(hashtextextended('tenant-configuration:'||v_tenant::text,0));
          PERFORM platform.validate_tenant_configuration(p_configuration,false);
          SELECT * INTO v_pending FROM platform.tenant_configuration_releases
            WHERE tenant_id=v_tenant AND status IN ('draft','submitted') FOR UPDATE;
          IF v_pending.id IS NOT NULL THEN
            IF v_pending.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'configuration revision conflict' USING ERRCODE='40001'; END IF;
            UPDATE platform.tenant_configuration_releases SET configuration=p_configuration,status='draft',
              revision=revision+1,submitted_at=NULL,review_notes=NULL WHERE id=v_pending.id RETURNING id INTO v_id;
          ELSE
            IF p_expected_revision IS NOT NULL THEN RAISE EXCEPTION 'configuration revision conflict' USING ERRCODE='40001'; END IF;
            INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,created_by_user_id)
              SELECT v_tenant,coalesce(max(version),0)+1,'draft',p_configuration,platform.current_user_id()
              FROM platform.tenant_configuration_releases WHERE tenant_id=v_tenant RETURNING id INTO v_id;
          END IF;
          INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata)
            VALUES(v_tenant,platform.current_user_id(),'tenant.configuration.saved','tenant_configuration',v_id,p_request_id,'{}');
          RETURN v_id;
        END $$;
        REVOKE ALL ON FUNCTION platform.save_tenant_configuration_draft(jsonb,integer,text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION platform.save_tenant_configuration_draft(jsonb,integer,text) TO platform_web;
    """)
    _execute("""
        CREATE FUNCTION platform.review_tenant_configuration(p_action text,p_expected_revision integer,p_note text,p_request_id text)
        RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_tenant uuid:=platform.current_tenant_id(); v_actor uuid:=platform.current_user_id();
          v_pending platform.tenant_configuration_releases%ROWTYPE; v_features text[]; v_process jsonb; v_required text[];
        BEGIN
          IF p_action NOT IN ('submit','approve','reject') OR length(coalesce(p_note,''))>2000 THEN
            RAISE EXCEPTION 'invalid review action' USING ERRCODE='22023'; END IF;
          IF NOT platform.configuration_actor_authorized(p_action<>'submit') THEN
            RAISE EXCEPTION 'configuration review denied' USING ERRCODE='42501'; END IF;
          PERFORM pg_advisory_xact_lock(hashtextextended('tenant-configuration:'||v_tenant::text,0));
          SELECT * INTO v_pending FROM platform.tenant_configuration_releases
            WHERE tenant_id=v_tenant AND status IN ('draft','submitted') FOR UPDATE;
          IF v_pending.id IS NULL THEN RAISE EXCEPTION 'no pending configuration' USING ERRCODE='P0002'; END IF;
          IF v_pending.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'configuration revision conflict' USING ERRCODE='40001'; END IF;
          IF p_action='submit' AND v_pending.status<>'draft' OR p_action IN ('approve','reject') AND v_pending.status<>'submitted' THEN
            RAISE EXCEPTION 'configuration is not at the required review stage' USING ERRCODE='TF409'; END IF;
          IF p_action<>'reject' THEN PERFORM platform.validate_tenant_configuration(v_pending.configuration,true); END IF;
          IF p_action='approve' THEN
            SELECT array_agg(value) INTO v_features FROM jsonb_array_elements_text(v_pending.configuration->'features');
            IF 'field_service'=ANY(v_features) AND NOT EXISTS(SELECT 1 FROM platform.tenant_feature_entitlements
              WHERE tenant_id=v_tenant AND feature_key='field_service' AND available) THEN
              RAISE EXCEPTION 'field service must first be granted by the platform administrator' USING ERRCODE='TF409'; END IF;
            UPDATE platform.tenant_configuration_releases SET status='published',revision=revision+1,
              approved_at=CURRENT_TIMESTAMP,approved_by_user_id=v_actor,review_notes=nullif(p_note,''),
              activation_xid=txid_current() WHERE id=v_pending.id;
            DELETE FROM automation.tenant_processes WHERE tenant_id=v_tenant;
            UPDATE platform.tenant_feature_entitlements SET enabled=feature_key=ANY(v_features),
              configuration=coalesce(v_pending.configuration->'featureConfiguration'->feature_key,'{}'::jsonb),
              source='operator',revision=revision+1,updated_by_user_id=v_actor,updated_at=CURRENT_TIMESTAMP
              WHERE tenant_id=v_tenant;
            INSERT INTO service.tenant_configuration(tenant_id,enabled,changed_by_user_id)
              VALUES(v_tenant,'field_service'=ANY(v_features),v_actor)
              ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,changed_by_user_id=v_actor,changed_at=CURRENT_TIMESTAMP;
            FOR v_process IN SELECT value FROM jsonb_array_elements(v_pending.configuration->'processes') LOOP
              SELECT coalesce(array_agg(value),'{}'::text[]) INTO v_required FROM jsonb_array_elements_text(coalesce(v_process->'requiredFeatures','[]'::jsonb));
              INSERT INTO automation.tenant_processes(tenant_id,name,purpose,enabled,trigger_key,channel,business_object_type,
                agent_profile_version_id,flow_version_id,required_features,priority,created_by_user_id,updated_by_user_id)
                VALUES(v_tenant,v_process->>'name',coalesce(v_process->>'purpose',''),(v_process->>'enabled')::boolean,
                  v_process->>'trigger',v_process->>'channel',v_process->>'businessObject',
                  (v_process->>'agentProfileVersionId')::uuid,(v_process->>'flowVersionId')::uuid,v_required,
                  coalesce((v_process->>'priority')::integer,100),v_actor,v_actor);
            END LOOP;
          ELSIF p_action='submit' THEN
            UPDATE platform.tenant_configuration_releases SET status='submitted',revision=revision+1,
              submitted_at=CURRENT_TIMESTAMP,review_notes=NULL WHERE id=v_pending.id;
          ELSE
            UPDATE platform.tenant_configuration_releases SET status='rejected',revision=revision+1,
              review_notes=nullif(p_note,'') WHERE id=v_pending.id;
          END IF;
          INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata)
            VALUES(v_tenant,v_actor,'tenant.configuration.'||p_action,'tenant_configuration',v_pending.id,p_request_id,
              jsonb_build_object('version',v_pending.version));
          RETURN v_pending.id;
        END $$;
        REVOKE ALL ON FUNCTION platform.review_tenant_configuration(text,integer,text,text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION platform.review_tenant_configuration(text,integer,text,text) TO platform_web;
    """)
    _execute("""
        CREATE FUNCTION platform.initialize_tenant_configuration(p_tenant uuid,p_configuration jsonb,p_request_id text)
        RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        BEGIN
          IF NOT platform.configuration_actor_authorized(true) OR NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=p_tenant AND status='active') THEN
            RAISE EXCEPTION 'platform administrator required' USING ERRCODE='42501'; END IF;
          PERFORM pg_advisory_xact_lock(hashtextextended('tenant-configuration:'||p_tenant::text,0));
          IF EXISTS(SELECT 1 FROM platform.tenant_configuration_releases WHERE tenant_id=p_tenant) THEN
            RAISE EXCEPTION 'tenant configuration already initialized' USING ERRCODE='TF409'; END IF;
          PERFORM platform.validate_tenant_configuration(p_configuration,false);
          UPDATE platform.tenant_feature_entitlements SET enabled=feature_key='contacts',revision=revision+1 WHERE tenant_id=p_tenant;
          UPDATE service.tenant_configuration SET enabled=false WHERE tenant_id=p_tenant;
          INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,approved_at,approved_by_user_id,created_by_user_id,review_notes)
            VALUES(p_tenant,1,'published','{"schemaVersion": 1,"templateKey": "blank","features": ["contacts"],"featureConfiguration": {},"processes": []}',
              CURRENT_TIMESTAMP,platform.current_user_id(),platform.current_user_id(),'Onboarding: contacts only until approval');
          INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,created_by_user_id)
            VALUES(p_tenant,2,'draft',p_configuration,platform.current_user_id());
          INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata)
            VALUES(p_tenant,platform.current_user_id(),'tenant.configuration.initialized','tenant',p_tenant,p_request_id,'{}');
        END $$;
        REVOKE ALL ON FUNCTION platform.initialize_tenant_configuration(uuid,jsonb,text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION platform.initialize_tenant_configuration(uuid,jsonb,text) TO platform_web;
    """)
    _execute("""
        CREATE FUNCTION platform.enforce_approved_configuration()
        RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_tenant uuid; v_active platform.tenant_configuration_releases%ROWTYPE;
        BEGIN
          v_tenant:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
          IF TG_TABLE_NAME='tenant_feature_entitlements' AND TG_OP='UPDATE'
            AND OLD.enabled=NEW.enabled AND OLD.configuration=NEW.configuration THEN RETURN NEW; END IF;
          SELECT * INTO v_active FROM platform.tenant_configuration_releases
            WHERE tenant_id=v_tenant AND status='published' ORDER BY version DESC LIMIT 1;
          IF v_active.id IS NOT NULL AND v_active.activation_xid IS DISTINCT FROM txid_current()
            AND EXISTS(SELECT 1 FROM public.tenants WHERE id=v_tenant AND status<>'deleted') THEN
            RAISE EXCEPTION 'Submit configuration changes for approval before activation' USING ERRCODE='TF409';
          END IF;
          IF TG_TABLE_NAME='tenant_feature_entitlements' THEN
            IF v_active.id IS NOT NULL
              AND (NEW.enabled IS DISTINCT FROM (v_active.configuration->'features' ? NEW.feature_key)
                OR NEW.configuration IS DISTINCT FROM coalesce(v_active.configuration->'featureConfiguration'->NEW.feature_key,'{}'::jsonb)) THEN
              RAISE EXCEPTION 'Module change does not match the approved configuration' USING ERRCODE='TF409';
            END IF;
          ELSIF TG_OP<>'DELETE' AND v_active.id IS NOT NULL THEN
            IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_active.configuration->'processes') item
              WHERE item->>'name'=NEW.name AND coalesce(item->>'purpose','')=NEW.purpose
                AND (item->>'enabled')::boolean=NEW.enabled AND item->>'trigger'=NEW.trigger_key
                AND item->>'channel' IS NOT DISTINCT FROM NEW.channel
                AND item->>'businessObject' IS NOT DISTINCT FROM NEW.business_object_type
                AND (item->>'agentProfileVersionId')::uuid IS NOT DISTINCT FROM NEW.agent_profile_version_id
                AND (item->>'flowVersionId')::uuid IS NOT DISTINCT FROM NEW.flow_version_id
                AND coalesce((item->>'priority')::integer,100)=NEW.priority
                AND ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'requiredFeatures','[]'::jsonb)))=NEW.required_features
                AND NEW.configuration='{}'::jsonb) THEN
              RAISE EXCEPTION 'Process change does not match the approved configuration' USING ERRCODE='TF409';
            END IF;
          END IF;
          RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
        END $$;
        REVOKE ALL ON FUNCTION platform.enforce_approved_configuration() FROM PUBLIC;
        CREATE TRIGGER trg_approved_tenant_modules BEFORE UPDATE ON platform.tenant_feature_entitlements
          FOR EACH ROW EXECUTE FUNCTION platform.enforce_approved_configuration();
        CREATE TRIGGER trg_approved_tenant_processes BEFORE INSERT OR UPDATE OR DELETE ON automation.tenant_processes
          FOR EACH ROW EXECUTE FUNCTION platform.enforce_approved_configuration();
        ALTER TABLE platform.tenant_template_applications DROP CONSTRAINT ck_tenant_template_key;
        ALTER TABLE platform.tenant_template_applications ADD CONSTRAINT ck_tenant_template_key
          CHECK(template_key IN ('field_service','lead_generation','customer_support','blank','leads_support','leads_only'));
    """)
    _execute("""
        CREATE FUNCTION platform.approved_agent_for_channel(p_agent uuid,p_channel text)
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT EXISTS(SELECT 1 FROM agents.agent_profile_versions agent
            WHERE agent.id=p_agent AND agent.tenant_id=platform.current_tenant_id()
              AND agent.published_at IS NOT NULL AND agent.validation_status='valid'
              AND EXISTS(SELECT 1 FROM agents.agent_profiles profile WHERE profile.id=agent.agent_profile_id AND profile.archived_at IS NULL)
              AND p_channel=ANY(agent.channel_capabilities)
              AND (NOT EXISTS(SELECT 1 FROM platform.tenant_configuration_releases release
                    WHERE release.tenant_id=agent.tenant_id AND release.status='published')
                OR EXISTS(SELECT 1 FROM automation.tenant_processes process
                    WHERE process.tenant_id=agent.tenant_id AND process.enabled
                      AND process.agent_profile_version_id=agent.id
                      AND CASE
                        WHEN process.trigger_key LIKE 'whatsapp.%' THEN 'whatsapp'
                        WHEN process.trigger_key LIKE 'voice.%' THEN 'voice'
                        ELSE process.channel END=p_channel)
                OR EXISTS(SELECT 1 FROM platform.tenant_configuration_releases baseline
                    WHERE baseline.tenant_id=agent.tenant_id AND baseline.version=1
                      AND baseline.status='published' AND baseline.created_by_user_id IS NULL
                      AND agent.published_at<=baseline.approved_at
                      AND NOT EXISTS(SELECT 1 FROM platform.tenant_configuration_releases newer
                        WHERE newer.tenant_id=agent.tenant_id AND newer.status='published' AND newer.version>1))))
        $$;
        REVOKE ALL ON FUNCTION platform.approved_agent_for_channel(uuid,text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION platform.approved_agent_for_channel(uuid,text) TO platform_web,platform_voice,platform_messaging,platform_worker;
        CREATE FUNCTION platform.current_tenant_requires_approved_routing()
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT EXISTS(SELECT 1 FROM platform.tenant_configuration_releases release
            WHERE release.tenant_id=platform.current_tenant_id() AND release.status='published'
              AND (release.version>1 OR release.created_by_user_id IS NOT NULL))
        $$;
        REVOKE ALL ON FUNCTION platform.current_tenant_requires_approved_routing() FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION platform.current_tenant_requires_approved_routing() TO platform_web,platform_voice,platform_messaging,platform_worker;
        CREATE FUNCTION platform.approved_flow_for_channel(p_flow uuid,p_agent uuid,p_channel text)
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT platform.approved_agent_for_channel(p_agent,p_channel) AND EXISTS(
            SELECT 1 FROM automation.flow_versions flow
            JOIN automation.flow_definitions definition ON definition.id=flow.flow_definition_id
              AND definition.tenant_id=flow.tenant_id AND definition.archived_at IS NULL
            WHERE flow.id=p_flow AND flow.tenant_id=platform.current_tenant_id()
              AND flow.published_at IS NOT NULL AND flow.validation_status='valid'
              AND p_channel=ANY(definition.channel_capabilities)
              AND (EXISTS(SELECT 1 FROM automation.tenant_processes process
                  WHERE process.tenant_id=flow.tenant_id AND process.enabled
                    AND process.flow_version_id=flow.id AND process.agent_profile_version_id=p_agent
                    AND CASE WHEN process.trigger_key LIKE 'whatsapp.%' THEN 'whatsapp'
                      WHEN process.trigger_key LIKE 'voice.%' THEN 'voice'
                      ELSE process.channel END=p_channel)
                OR NOT EXISTS(SELECT 1 FROM platform.tenant_configuration_releases release
                  WHERE release.tenant_id=flow.tenant_id AND release.status='published')
                OR EXISTS(SELECT 1 FROM platform.tenant_configuration_releases baseline
                  WHERE baseline.tenant_id=flow.tenant_id AND baseline.version=1
                    AND baseline.status='published' AND baseline.created_by_user_id IS NULL
                    AND flow.published_at<=baseline.approved_at
                    AND NOT platform.current_tenant_requires_approved_routing())))
        $$;
        REVOKE ALL ON FUNCTION platform.approved_flow_for_channel(uuid,uuid,text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION platform.approved_flow_for_channel(uuid,uuid,text) TO platform_web,platform_voice,platform_messaging,platform_worker;
        CREATE FUNCTION platform.enforce_approved_conversation_agent()
        RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        BEGIN
          IF NEW.ownership_mode='ai' AND NEW.ai_agent_profile_version_id IS NOT NULL
            AND (TG_OP='INSERT' OR OLD.ai_agent_profile_version_id IS DISTINCT FROM NEW.ai_agent_profile_version_id
              OR OLD.ownership_mode IS DISTINCT FROM NEW.ownership_mode)
            AND NOT platform.approved_agent_for_channel(NEW.ai_agent_profile_version_id,'whatsapp') THEN
            RAISE EXCEPTION 'Approve this agent version in the workspace workflow before assignment' USING ERRCODE='TF409';
          END IF;
          RETURN NEW;
        END $$;
        REVOKE ALL ON FUNCTION platform.enforce_approved_conversation_agent() FROM PUBLIC;
        CREATE TRIGGER trg_approved_conversation_agent BEFORE INSERT OR UPDATE ON messaging.conversations
          FOR EACH ROW EXECUTE FUNCTION platform.enforce_approved_conversation_agent();
    """)
    _execute("""
        CREATE FUNCTION platform.enforce_approved_service_activation()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_configuration jsonb;
        BEGIN
          -- An entitlement grant ensures the row exists with ON CONFLICT DO
          -- NOTHING. Do not mistake its unused default for an activation edit.
          IF TG_OP='INSERT' THEN
            PERFORM 1 FROM service.tenant_configuration WHERE tenant_id=NEW.tenant_id FOR KEY SHARE;
            IF FOUND THEN RETURN NEW; END IF;
          ELSIF OLD.enabled=NEW.enabled THEN
            RETURN NEW;
          END IF;
          -- Platform revocation is a separate emergency stop, not publication.
          IF NOT NEW.enabled AND NOT EXISTS(SELECT 1 FROM platform.tenant_feature_entitlements
            WHERE tenant_id=NEW.tenant_id AND feature_key='field_service' AND available) THEN
            RETURN NEW;
          END IF;
          SELECT configuration INTO v_configuration FROM platform.tenant_configuration_releases
            WHERE tenant_id=NEW.tenant_id AND status='published' ORDER BY version DESC LIMIT 1;
          IF v_configuration IS NOT NULL
            AND EXISTS(SELECT 1 FROM public.tenants WHERE id=NEW.tenant_id AND status<>'deleted')
            AND NEW.enabled IS DISTINCT FROM (v_configuration->'features' ? 'field_service') THEN
            RAISE EXCEPTION 'Change field service activation through the approved workspace configuration' USING ERRCODE='TF409';
          END IF;
          RETURN NEW;
        END $$;
        REVOKE ALL ON FUNCTION platform.enforce_approved_service_activation() FROM PUBLIC;
        CREATE TRIGGER trg_approved_service_activation BEFORE INSERT OR UPDATE ON service.tenant_configuration
          FOR EACH ROW EXECUTE FUNCTION platform.enforce_approved_service_activation();
    """)


def downgrade() -> None:
    # Retain the approval trail instead of silently deleting published decisions.
    _execute("""
        DO $$ BEGIN
          IF EXISTS(SELECT 1 FROM platform.tenant_configuration_releases WHERE version>1) THEN
            RAISE EXCEPTION 'reviewed configuration history must be retained; export it before downgrade';
          END IF;
        END $$;
        DROP TRIGGER trg_approved_tenant_processes ON automation.tenant_processes;
        DROP TRIGGER trg_approved_conversation_agent ON messaging.conversations;
        DROP FUNCTION platform.enforce_approved_conversation_agent();
        DROP FUNCTION platform.approved_flow_for_channel(uuid,uuid,text);
        DROP FUNCTION platform.current_tenant_requires_approved_routing();
        DROP FUNCTION platform.approved_agent_for_channel(uuid,text);
        DROP TRIGGER trg_approved_tenant_modules ON platform.tenant_feature_entitlements;
        DROP TRIGGER trg_approved_service_activation ON service.tenant_configuration;
        DROP FUNCTION platform.enforce_approved_service_activation();
        DROP FUNCTION platform.enforce_approved_configuration();
        DROP FUNCTION platform.initialize_tenant_configuration(uuid,jsonb,text);
        DROP FUNCTION platform.review_tenant_configuration(text,integer,text,text);
        DROP FUNCTION platform.save_tenant_configuration_draft(jsonb,integer,text);
        DROP FUNCTION platform.validate_tenant_configuration(jsonb,boolean);
        DROP FUNCTION platform.configuration_actor_authorized(boolean);
        DROP TABLE platform.tenant_configuration_releases;
        ALTER TABLE platform.tenant_template_applications DROP CONSTRAINT ck_tenant_template_key;
        ALTER TABLE platform.tenant_template_applications ADD CONSTRAINT ck_tenant_template_key
          CHECK(template_key IN ('field_service','lead_generation','customer_support','blank'));
    """)
