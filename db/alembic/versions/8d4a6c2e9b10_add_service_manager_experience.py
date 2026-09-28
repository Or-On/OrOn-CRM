"""Add a reviewed service-manager presentation without changing capabilities.

Revision ID: 8d4a6c2e9b10
Revises: 6f8b0d3e5a29
"""

# ruff: noqa: E501 -- preserve the complete reviewed configuration validator.
from alembic import op

revision = "8d4a6c2e9b10"
down_revision = "6f8b0d3e5a29"
branch_labels = None
depends_on = None

PREVIOUS_VALIDATOR = r"""
CREATE OR REPLACE FUNCTION platform.validate_tenant_configuration(p_configuration jsonb,p_validate_bindings boolean DEFAULT true)
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

    IF v_process->>'businessObject'='lead' THEN
      IF NOT coalesce(v_agent.tool_permissions @> '["lead.write"]'::jsonb,false) THEN
        RAISE EXCEPTION 'lead workflows require an agent with lead.write' USING ERRCODE='TF409';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM crm.lead_field_schemas schema
        WHERE schema.tenant_id=platform.current_tenant_id()
          AND schema.id::text=lower(v_agent.channel_configuration->>'leadFieldSchemaId')
          AND schema.published_at IS NOT NULL
          AND jsonb_array_length(schema.definition) BETWEEN 1 AND 40
      ) THEN
        RAISE EXCEPTION 'lead workflows require a pinned published lead field schema in this workspace'
          USING ERRCODE='TF409';
      END IF;
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
"""

SERVICE_MANAGER_VALIDATOR = r"""
CREATE OR REPLACE FUNCTION platform.validate_tenant_configuration(p_configuration jsonb,p_validate_bindings boolean DEFAULT true)
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
    IF v_feature='field_service' THEN
              IF (v_configuration-'workflow'-'experience')<>'{}'::jsonb
                OR (v_configuration ? 'workflow' AND NOT service.validate_workflow_policy(v_configuration->'workflow'))
                OR (v_configuration ? 'experience' AND (
                  jsonb_typeof(v_configuration->'experience') IS DISTINCT FROM 'string'
                  OR v_configuration->>'experience' NOT IN ('standard','service_manager'))) THEN
                RAISE EXCEPTION 'invalid field service configuration' USING ERRCODE='22023';
              END IF;
            ELSIF v_configuration<>'{}'::jsonb THEN
              RAISE EXCEPTION 'module does not support these configuration fields' USING ERRCODE='22023';
            END IF;
          END LOOP;
  IF p_configuration#>>'{featureConfiguration,field_service,experience}'='service_manager'
    AND 'field_service'=ANY(v_features) AND NOT 'tickets'=ANY(v_features) THEN
    RAISE EXCEPTION 'service manager requires field service and tickets' USING ERRCODE='TF409';
  END IF;
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

    IF v_process->>'businessObject'='lead' THEN
      IF NOT coalesce(v_agent.tool_permissions @> '["lead.write"]'::jsonb,false) THEN
        RAISE EXCEPTION 'lead workflows require an agent with lead.write' USING ERRCODE='TF409';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM crm.lead_field_schemas schema
        WHERE schema.tenant_id=platform.current_tenant_id()
          AND schema.id::text=lower(v_agent.channel_configuration->>'leadFieldSchemaId')
          AND schema.published_at IS NOT NULL
          AND jsonb_array_length(schema.definition) BETWEEN 1 AND 40
      ) THEN
        RAISE EXCEPTION 'lead workflows require a pinned published lead field schema in this workspace'
          USING ERRCODE='TF409';
      END IF;
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
"""


def upgrade() -> None:
    op.execute(SERVICE_MANAGER_VALIDATOR)
    # The simple register pages by opening date rather than recent activity.
    op.execute("""CREATE INDEX ix_support_tickets_opened_at
      ON support.tickets (tenant_id, opened_at DESC, id DESC)""")


def downgrade() -> None:
    # Refuse to invalidate an active configuration. Operators first publish
    # a compatible package without experience; release history is preserved.
    op.execute("""DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM platform.tenant_feature_entitlements
        WHERE feature_key='field_service' AND configuration ? 'experience') THEN
        RAISE EXCEPTION 'Publish field service configurations without experience before downgrading';
      END IF;
    END $$;""")
    op.execute(PREVIOUS_VALIDATOR)
    op.execute("DROP INDEX support.ix_support_tickets_opened_at")
