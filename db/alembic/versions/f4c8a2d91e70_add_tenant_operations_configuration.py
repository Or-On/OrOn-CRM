"""add canonical tenant modules, templates and process bindings

Revision ID: f4c8a2d91e70
Revises: e3b9d7f1a2c6
Create Date: 2026-09-19 20:00:00.000000
"""

# ruff: noqa: E501, S608 -- generated SQL uses only closed migration-owned constants.

from collections.abc import Sequence

from alembic import op

revision: str = "f4c8a2d91e70"
down_revision: str | None = "e3b9d7f1a2c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


FEATURES = (
    "contacts",
    "whatsapp",
    "voice",
    "agents",
    "leads",
    "pipeline",
    "tickets",
    "field_service",
    "technicians",
    "ocr",
    "documents",
    "reports",
    "appointments",
    "billing",
)


def upgrade() -> None:
    keys = ",".join(f"'{key}'" for key in FEATURES)
    op.execute(
        "ALTER TABLE platform.tenant_feature_entitlements DROP CONSTRAINT ck_tenant_feature_key"
    )
    op.execute(f"""
        ALTER TABLE platform.tenant_feature_entitlements
          ADD COLUMN enabled boolean NOT NULL DEFAULT false,
          ADD COLUMN configuration jsonb NOT NULL DEFAULT '{{}}'::jsonb,
          ADD COLUMN configuration_schema_version integer NOT NULL DEFAULT 1,
          ADD COLUMN source text NOT NULL DEFAULT 'migration',
          ADD COLUMN updated_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          ADD COLUMN revision integer NOT NULL DEFAULT 1,
          ADD CONSTRAINT ck_tenant_feature_key CHECK (feature_key IN ({keys})),
          ADD CONSTRAINT ck_tenant_feature_configuration CHECK (
            jsonb_typeof(configuration) = 'object'
            AND octet_length(configuration::text) <= 16384
          ),
          ADD CONSTRAINT ck_tenant_feature_schema_version CHECK (
            configuration_schema_version BETWEEN 1 AND 1000
          ),
          ADD CONSTRAINT ck_tenant_feature_source CHECK (
            source IN ('migration','template','operator','provisioning')
          ),
          ADD CONSTRAINT ck_tenant_feature_revision CHECK (revision > 0)
    """)
    op.execute(f"""
        CREATE FUNCTION platform.provision_tenant_features()
        RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path=pg_catalog AS $$
        BEGIN
          INSERT INTO platform.tenant_feature_entitlements(
            tenant_id,feature_key,available,enabled,granted_at,
            configuration,configuration_schema_version,source,revision
          ) SELECT NEW.id,feature.key,true,
              true,
              CURRENT_TIMESTAMP,
              '{{}}'::jsonb,1,'provisioning',1
            FROM (VALUES {",".join(f"('{key}')" for key in FEATURES)}) feature(key)
            WHERE feature.key<>'field_service';
          RETURN NEW;
        END $$
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.provision_tenant_features() FROM PUBLIC")
    op.execute("""
        CREATE TRIGGER trg_provision_tenant_features
        AFTER INSERT ON public.tenants
        FOR EACH ROW EXECUTE FUNCTION platform.provision_tenant_features()
    """)

    # Existing tenants retain every product area that was previously globally
    # reachable. Field-service remains governed by its existing entitlement +
    # configuration pair; its dependent modules follow its effective state.
    op.execute(f"""
        INSERT INTO platform.tenant_feature_entitlements(
          tenant_id, feature_key, available, enabled, granted_at,
          configuration, configuration_schema_version, source, revision
        )
        SELECT tenant.id, feature.key,
          CASE WHEN feature.key='field_service'
            THEN coalesce(existing.available,false) ELSE true END,
          CASE
            WHEN feature.key = 'field_service' THEN
              coalesce(existing.available, false) AND coalesce(service.enabled, false)
            WHEN feature.key IN ('technicians','ocr') THEN
              coalesce(existing.available, false) AND coalesce(service.enabled, false)
            ELSE true
          END,
          CURRENT_TIMESTAMP, '{{}}'::jsonb, 1, 'migration', 1
        FROM public.tenants tenant
        CROSS JOIN (VALUES {",".join(f"('{key}')" for key in FEATURES)}) feature(key)
        LEFT JOIN platform.tenant_feature_entitlements existing
          ON existing.tenant_id=tenant.id AND existing.feature_key='field_service'
        LEFT JOIN service.tenant_configuration service ON service.tenant_id=tenant.id
        WHERE tenant.status <> 'deleted'
        ON CONFLICT (tenant_id, feature_key) DO UPDATE SET
          enabled = CASE
            WHEN EXCLUDED.feature_key='field_service' THEN EXCLUDED.enabled
            ELSE platform.tenant_feature_entitlements.enabled
          END,
          configuration = coalesce(platform.tenant_feature_entitlements.configuration, '{{}}'::jsonb),
          source = 'migration', updated_at=CURRENT_TIMESTAMP
    """)

    op.execute("""
        CREATE TABLE platform.tenant_template_applications (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          template_key text NOT NULL,
          template_version integer NOT NULL,
          applied_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          request_id text,
          UNIQUE (tenant_id, template_key, template_version),
          CONSTRAINT ck_tenant_template_key CHECK (
            template_key IN ('field_service','lead_generation','customer_support','blank')
          ),
          CONSTRAINT ck_tenant_template_version CHECK (template_version > 0)
        )
    """)
    op.execute("""
        CREATE TABLE automation.tenant_processes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          name text NOT NULL,
          purpose text NOT NULL DEFAULT '',
          enabled boolean NOT NULL DEFAULT false,
          trigger_key text NOT NULL,
          channel text,
          business_object_type text,
          agent_profile_version_id uuid,
          flow_version_id uuid,
          required_features text[] NOT NULL DEFAULT ARRAY[]::text[],
          configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
          configuration_schema_version integer NOT NULL DEFAULT 1,
          priority integer NOT NULL DEFAULT 100,
          revision integer NOT NULL DEFAULT 1,
          created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          updated_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          FOREIGN KEY (tenant_id, agent_profile_version_id)
            REFERENCES agents.agent_profile_versions(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, flow_version_id)
            REFERENCES automation.flow_versions(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_tenant_process_name CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
          CONSTRAINT ck_tenant_process_purpose CHECK (char_length(purpose) <= 1000),
          CONSTRAINT ck_tenant_process_trigger CHECK (trigger_key IN (
            'whatsapp.new_conversation','whatsapp.message','voice.inbound',
            'voice.outbound_assignment','manual.contact_action','lead.new',
            'service_case.created'
          )),
          CONSTRAINT ck_tenant_process_channel CHECK (
            channel IS NULL OR channel IN ('whatsapp','voice','manual')
          ),
          CONSTRAINT ck_tenant_process_object CHECK (
            business_object_type IS NULL OR business_object_type IN (
              'contact','lead','deal','ticket','service_case','appointment','document'
            )
          ),
          CONSTRAINT ck_tenant_process_features CHECK (
            required_features <@ ARRAY[
              'contacts','whatsapp','voice','agents','leads','pipeline','tickets',
              'field_service','technicians','ocr','documents','reports','appointments','billing'
            ]::text[]
          ),
          CONSTRAINT ck_tenant_process_configuration CHECK (
            jsonb_typeof(configuration)='object'
            AND octet_length(configuration::text) <= 32768
          ),
          CONSTRAINT ck_tenant_process_numbers CHECK (
            configuration_schema_version BETWEEN 1 AND 1000
            AND priority BETWEEN 0 AND 10000 AND revision > 0
          ),
          CONSTRAINT ck_tenant_process_binding CHECK (
            NOT enabled OR (agent_profile_version_id IS NOT NULL AND flow_version_id IS NOT NULL)
          )
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_tenant_process_active_precedence
        ON automation.tenant_processes(
          tenant_id, trigger_key, coalesce(channel, ''), priority
        ) WHERE enabled
    """)
    op.execute("""
        CREATE INDEX ix_tenant_process_routing
        ON automation.tenant_processes(tenant_id, trigger_key, channel, priority, id)
        WHERE enabled
    """)

    for table in ("tenant_template_applications",):
        op.execute(f"ALTER TABLE platform.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE platform.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""
            CREATE POLICY tenant_isolation ON platform.{table}
            USING (tenant_id=platform.current_tenant_id())
            WITH CHECK (tenant_id=platform.current_tenant_id())
        """)
    op.execute("ALTER TABLE automation.tenant_processes ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE automation.tenant_processes FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY tenant_isolation ON automation.tenant_processes
        USING (tenant_id=platform.current_tenant_id())
        WITH CHECK (tenant_id=platform.current_tenant_id())
    """)

    op.execute("""
        CREATE FUNCTION platform.tenant_feature_enabled_for(p_tenant uuid,p_feature text)
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path=pg_catalog AS $$
          SELECT CASE WHEN p_feature='field_service' THEN
            coalesce(feature.available,false) AND coalesce(service.enabled,false)
          ELSE coalesce(feature.available,false) AND coalesce(feature.enabled,false) END
          FROM (SELECT p_tenant AS tenant_id) current
          LEFT JOIN platform.tenant_feature_entitlements feature
            ON feature.tenant_id=current.tenant_id AND feature.feature_key=p_feature
          LEFT JOIN service.tenant_configuration service
            ON service.tenant_id=current.tenant_id
        $$
    """)
    op.execute("""
        CREATE FUNCTION platform.current_tenant_feature_enabled(p_feature text)
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path=pg_catalog AS $$
          SELECT platform.tenant_feature_enabled_for(
            platform.current_tenant_id(),p_feature
          )
        $$
    """)
    op.execute("""
        CREATE FUNCTION platform.set_current_tenant_feature(
          p_feature text, p_enabled boolean, p_configuration jsonb,
          p_schema_version integer, p_expected_revision integer,
          p_source text, p_request_id text
        ) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path=pg_catalog AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_actor uuid := platform.current_user_id();
                v_current integer; v_dependency text; v_process text;
        BEGIN
          IF p_feature NOT IN (
            'contacts','whatsapp','voice','agents','leads','pipeline','tickets',
            'field_service','technicians','ocr','documents','reports','appointments','billing'
          ) THEN RAISE EXCEPTION 'unknown tenant feature' USING ERRCODE='22023'; END IF;
          IF p_configuration IS NULL OR jsonb_typeof(p_configuration)<>'object'
             OR octet_length(p_configuration::text)>16384 OR p_schema_version<>1 THEN
            RAISE EXCEPTION 'invalid tenant feature configuration' USING ERRCODE='22023';
          END IF;
          IF p_source NOT IN ('template','operator','provisioning') THEN
            RAISE EXCEPTION 'invalid tenant feature source' USING ERRCODE='22023';
          END IF;
          IF NOT platform.canonical_actor_authorized() THEN
            RAISE EXCEPTION 'tenant management permission required' USING ERRCODE='42501';
          END IF;
          SELECT revision INTO v_current FROM platform.tenant_feature_entitlements
          WHERE tenant_id=v_tenant AND feature_key=p_feature FOR UPDATE;
          IF v_current IS NULL THEN RAISE EXCEPTION 'tenant feature is not provisioned' USING ERRCODE='P0002'; END IF;
          IF v_current<>p_expected_revision THEN RAISE EXCEPTION 'tenant feature revision conflict' USING ERRCODE='40001'; END IF;
          IF p_enabled THEN
            SELECT dependency INTO v_dependency FROM (VALUES
              ('whatsapp','contacts'),('voice','contacts'),('voice','agents'),
              ('leads','contacts'),('pipeline','contacts'),('tickets','contacts'),
              ('field_service','contacts'),('technicians','field_service'),
              ('ocr','documents'),('reports','contacts'),('appointments','contacts')
            ) dependency(feature,dependency)
            WHERE feature=p_feature AND NOT platform.current_tenant_feature_enabled(dependency)
            LIMIT 1;
            IF v_dependency IS NOT NULL THEN
              RAISE EXCEPTION 'feature requires %', v_dependency USING ERRCODE='TF409';
            END IF;
          ELSE
            SELECT dependency.feature INTO v_dependency FROM (VALUES
              ('whatsapp','contacts'),('voice','contacts'),('voice','agents'),
              ('leads','contacts'),('pipeline','contacts'),('tickets','contacts'),
              ('field_service','contacts'),('technicians','field_service'),
              ('ocr','documents'),('reports','contacts'),('appointments','contacts')
            ) dependency(feature,dependency)
            WHERE dependency.dependency=p_feature
              AND platform.current_tenant_feature_enabled(dependency.feature)
            LIMIT 1;
            SELECT process.name INTO v_process FROM automation.tenant_processes process
            WHERE process.tenant_id=v_tenant AND process.enabled
              AND p_feature=ANY(process.required_features) LIMIT 1;
            IF v_dependency IS NOT NULL THEN
              RAISE EXCEPTION 'feature is required by enabled feature %', v_dependency USING ERRCODE='TF409';
            END IF;
            IF v_process IS NOT NULL THEN
              RAISE EXCEPTION 'feature is required by active process %', v_process USING ERRCODE='TF409';
            END IF;
          END IF;
          IF p_feature='field_service' AND p_enabled AND NOT EXISTS (
            SELECT 1 FROM platform.tenant_feature_entitlements
            WHERE tenant_id=v_tenant AND feature_key=p_feature AND available
          ) THEN RAISE EXCEPTION 'field service is not available' USING ERRCODE='42501'; END IF;
          UPDATE platform.tenant_feature_entitlements SET
            enabled=p_enabled, configuration=p_configuration,
            configuration_schema_version=p_schema_version, source=p_source,
            updated_by_user_id=v_actor, updated_at=CURRENT_TIMESTAMP,
            revision=revision+1
          WHERE tenant_id=v_tenant AND feature_key=p_feature;
          IF p_feature='field_service' THEN
            INSERT INTO service.tenant_configuration(tenant_id,enabled,changed_by_user_id)
            VALUES(v_tenant,p_enabled,v_actor) ON CONFLICT (tenant_id) DO UPDATE SET
              enabled=EXCLUDED.enabled, changed_by_user_id=v_actor, changed_at=CURRENT_TIMESTAMP;
          END IF;
          INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata)
          VALUES(v_tenant,v_actor,'tenant.feature.updated','tenant',v_tenant,p_request_id,
            jsonb_build_object('feature',p_feature,'enabled',p_enabled,'source',p_source,'revision',v_current+1));
          RETURN v_current+1;
        END $$
    """)
    op.execute("""
        CREATE FUNCTION platform.apply_tenant_template_for_administrator(
          p_tenant uuid,p_template text,p_request_id text
        ) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path=pg_catalog AS $$
        DECLARE v_actor uuid := platform.current_user_id(); v_version integer := 1;
                v_features text[];
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=v_actor AND status='active' AND is_superuser) THEN
            RAISE EXCEPTION 'platform administrator permission required' USING ERRCODE='42501';
          END IF;
          v_features := CASE p_template
            WHEN 'field_service' THEN ARRAY['contacts','agents','whatsapp','voice','field_service','technicians','documents','ocr','reports','appointments']::text[]
            WHEN 'lead_generation' THEN ARRAY['contacts','agents','whatsapp','voice','leads','pipeline']::text[]
            WHEN 'customer_support' THEN ARRAY['contacts','agents','whatsapp','voice','tickets']::text[]
            WHEN 'blank' THEN ARRAY['contacts']::text[]
            ELSE NULL END;
          IF v_features IS NULL THEN RAISE EXCEPTION 'unknown tenant template' USING ERRCODE='22023'; END IF;
          IF EXISTS (
            SELECT 1 FROM platform.tenant_template_applications
            WHERE tenant_id=p_tenant AND template_key=p_template
              AND template_version=v_version
          ) THEN RETURN; END IF;
          IF p_template='field_service' AND NOT EXISTS (
            SELECT 1 FROM platform.tenant_feature_entitlements
            WHERE tenant_id=p_tenant AND feature_key='field_service' AND available
          ) THEN RAISE EXCEPTION 'field service template requires entitlement' USING ERRCODE='42501'; END IF;
          UPDATE platform.tenant_feature_entitlements SET
            enabled=feature_key=ANY(v_features),source='template',updated_by_user_id=v_actor,
            updated_at=CURRENT_TIMESTAMP,revision=revision+1
          WHERE tenant_id=p_tenant;
          IF p_template='field_service' THEN
            INSERT INTO service.tenant_configuration(tenant_id,enabled,changed_by_user_id)
            VALUES(p_tenant,true,v_actor) ON CONFLICT(tenant_id) DO UPDATE SET
              enabled=true,changed_by_user_id=v_actor,changed_at=CURRENT_TIMESTAMP;
          END IF;
          INSERT INTO platform.tenant_template_applications(
            tenant_id,template_key,template_version,applied_by_user_id,request_id
          ) VALUES(p_tenant,p_template,v_version,v_actor,p_request_id)
          ON CONFLICT(tenant_id,template_key,template_version) DO NOTHING;
          INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata)
          VALUES(p_tenant,v_actor,'tenant.template.applied','tenant',p_tenant,p_request_id,
            jsonb_build_object('template',p_template,'version',v_version));
        END $$
    """)
    op.execute("""
        CREATE FUNCTION platform.enforce_tenant_feature_write()
        RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path=pg_catalog AS $$
        DECLARE v_tenant uuid := CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
        BEGIN
          IF NOT platform.tenant_feature_enabled_for(v_tenant,TG_ARGV[0]) THEN
            RAISE EXCEPTION 'tenant feature % is disabled', TG_ARGV[0]
              USING ERRCODE='TF403';
          END IF;
          RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
        END $$
    """)
    for schema, table, feature in (
        ("crm", "leads", "leads"),
        ("crm", "lead_field_values", "leads"),
        ("crm", "lead_interactions", "leads"),
        ("support", "tickets", "tickets"),
        ("service", "cases", "field_service"),
        ("service", "technicians", "technicians"),
        ("service", "ocr_results", "ocr"),
    ):
        op.execute(f"""
            CREATE TRIGGER trg_{table}_tenant_feature
            BEFORE INSERT OR UPDATE OR DELETE ON {schema}.{table}
            FOR EACH ROW EXECUTE FUNCTION platform.enforce_tenant_feature_write('{feature}')
        """)
    op.execute("REVOKE ALL ON FUNCTION platform.enforce_tenant_feature_write() FROM PUBLIC")
    op.execute("REVOKE ALL ON FUNCTION platform.current_tenant_feature_enabled(text) FROM PUBLIC")
    op.execute("REVOKE ALL ON FUNCTION platform.tenant_feature_enabled_for(uuid,text) FROM PUBLIC")
    op.execute(
        "REVOKE ALL ON FUNCTION platform.set_current_tenant_feature(text,boolean,jsonb,integer,integer,text,text) FROM PUBLIC"
    )
    op.execute(
        "REVOKE ALL ON FUNCTION platform.apply_tenant_template_for_administrator(uuid,text,text) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.current_tenant_feature_enabled(text) TO platform_web,platform_worker,platform_messaging,platform_voice,platform_readonly"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.set_current_tenant_feature(text,boolean,jsonb,integer,integer,text,text) TO platform_web"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.apply_tenant_template_for_administrator(uuid,text,text) TO platform_web"
    )
    op.execute(
        "GRANT SELECT ON platform.tenant_template_applications TO platform_web,platform_readonly"
    )
    op.execute("GRANT SELECT,INSERT ON platform.tenant_template_applications TO platform_web")
    op.execute(
        "GRANT SELECT ON automation.tenant_processes TO platform_worker,platform_messaging,platform_voice,platform_readonly"
    )
    op.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON automation.tenant_processes TO platform_web")


def downgrade() -> None:
    op.execute(
        "DROP FUNCTION IF EXISTS platform.apply_tenant_template_for_administrator(uuid,text,text)"
    )
    for schema, table in (
        ("crm", "leads"),
        ("crm", "lead_field_values"),
        ("crm", "lead_interactions"),
        ("support", "tickets"),
        ("service", "cases"),
        ("service", "technicians"),
        ("service", "ocr_results"),
    ):
        op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_tenant_feature ON {schema}.{table}")
    op.execute("DROP FUNCTION IF EXISTS platform.enforce_tenant_feature_write()")
    op.execute(
        "DROP FUNCTION IF EXISTS platform.set_current_tenant_feature(text,boolean,jsonb,integer,integer,text,text)"
    )
    op.execute("DROP FUNCTION IF EXISTS platform.current_tenant_feature_enabled(text)")
    op.execute("DROP FUNCTION IF EXISTS platform.tenant_feature_enabled_for(uuid,text)")
    op.execute("DROP TABLE automation.tenant_processes")
    op.execute("DROP TABLE platform.tenant_template_applications")
    op.execute("DROP TRIGGER IF EXISTS trg_provision_tenant_features ON public.tenants")
    op.execute("DROP FUNCTION IF EXISTS platform.provision_tenant_features()")
    op.execute(
        "DELETE FROM platform.tenant_feature_entitlements WHERE feature_key<>'field_service'"
    )
    op.execute("""
        ALTER TABLE platform.tenant_feature_entitlements
          DROP CONSTRAINT ck_tenant_feature_revision,
          DROP CONSTRAINT ck_tenant_feature_source,
          DROP CONSTRAINT ck_tenant_feature_schema_version,
          DROP CONSTRAINT ck_tenant_feature_configuration,
          DROP CONSTRAINT ck_tenant_feature_key,
          DROP COLUMN revision,
          DROP COLUMN updated_by_user_id,
          DROP COLUMN source,
          DROP COLUMN configuration_schema_version,
          DROP COLUMN configuration,
          DROP COLUMN enabled,
          ADD CONSTRAINT ck_tenant_feature_key CHECK (feature_key='field_service')
    """)
