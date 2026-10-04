"""Prepared default-off, non-login tenant conversation execution principal boundary."""

from alembic import op

revision = "f3db9526a81d"
down_revision = "f2ca8415970c"
branch_labels = None
depends_on = None

SQL = """
CREATE TABLE platform.ai_execution_principals(
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 role text NOT NULL CHECK(role='conversation_model_reader_v1'),
 status text NOT NULL CHECK(status IN ('active','inactive')),
 membership_status text NOT NULL CHECK(membership_status IN ('active','revoked')),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE platform.tenant_ai_execution_bindings(
 tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
 enabled boolean NOT NULL DEFAULT false,
 principal_id uuid,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES platform.ai_execution_principals(tenant_id,id)
 ON DELETE RESTRICT
);
ALTER TABLE ops.jobs ADD CONSTRAINT uq_jobs_principal_tenant_id UNIQUE(tenant_id,id);
CREATE TABLE ops.ai_principal_alerts(
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 job_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('principal_missing','principal_inactive',
  'principal_membership_invalid','principal_role_invalid','principal_tool_bridge_unavailable')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,job_id,reason),
 FOREIGN KEY(tenant_id,job_id) REFERENCES ops.jobs(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE platform.ai_execution_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.ai_execution_principals FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_ai_execution_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.tenant_ai_execution_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.ai_principal_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.ai_principal_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_execution_principals_tenant ON platform.ai_execution_principals
 USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
CREATE POLICY tenant_ai_execution_bindings_tenant ON platform.tenant_ai_execution_bindings
 USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
CREATE POLICY ai_principal_alerts_tenant ON ops.ai_principal_alerts
 USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON platform.ai_execution_principals,
 platform.tenant_ai_execution_bindings,ops.ai_principal_alerts TO platform_migrator;
CREATE FUNCTION platform.admit_messaging_execution_principal(p_job uuid,p_worker text,p_claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE binding platform.tenant_ai_execution_bindings%ROWTYPE;
 principal platform.ai_execution_principals%ROWTYPE;
 permissions jsonb; reason text; consent_actor uuid;
BEGIN
 -- No caller-supplied tenant, role, principal, or tool permissions are accepted.
 SELECT to_jsonb(a.tool_permissions),c.ai_enabled_by_user_id INTO permissions,consent_actor
 FROM ops.jobs j JOIN messaging.conversations c ON c.tenant_id=j.tenant_id AND c.id=j.reference_id
 JOIN agents.agent_profile_versions a ON a.tenant_id=c.tenant_id
 AND a.id=c.ai_agent_profile_version_id
 JOIN agents.agent_profiles p ON p.tenant_id=a.tenant_id
 AND p.id=a.agent_profile_id AND p.archived_at IS NULL
 JOIN public.tenants t ON t.id=j.tenant_id AND t.status='active'
 WHERE j.tenant_id=platform.current_tenant_id() AND j.id=p_job
 AND j.queue='messaging' AND j.job_type='whatsapp.ai.reply' AND j.status='running'
 AND j.reference_type='conversation' AND j.locked_by=p_worker AND j.claim_token=p_claim
 AND j.lease_expires_at>clock_timestamp()
 AND c.ownership_mode='ai' AND c.removed_from_inbox_at IS NULL
 AND a.published_at IS NOT NULL AND a.validation_status='valid'
 AND 'whatsapp'=ANY(a.channel_capabilities)
 AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
 FOR UPDATE OF j,c;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO binding FROM platform.tenant_ai_execution_bindings
 WHERE tenant_id=platform.current_tenant_id() FOR SHARE;
 IF NOT FOUND OR NOT binding.enabled THEN RETURN jsonb_build_object('mode','legacy'); END IF;
 SELECT * INTO principal FROM platform.ai_execution_principals
 WHERE tenant_id=binding.tenant_id AND id=binding.principal_id FOR SHARE;
 IF NOT FOUND THEN reason:='principal_missing';
 ELSIF principal.status<>'active' THEN reason:='principal_inactive';
 ELSIF principal.membership_status<>'active' THEN reason:='principal_membership_invalid';
 ELSIF principal.role<>'conversation_model_reader_v1' THEN reason:='principal_role_invalid';
 ELSIF permissions IS DISTINCT FROM '[]'::jsonb THEN reason:='principal_tool_bridge_unavailable';
 END IF;
 IF reason IS NOT NULL THEN
  INSERT INTO ops.ai_principal_alerts(tenant_id,job_id,reason)
  VALUES(binding.tenant_id,p_job,reason) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('mode','denied','reason',reason);
 END IF;
 -- The actor column remains human consent provenance; metadata names the
 -- separate machine execution authority. This is authorization, not a claim
 -- that the provider accepted a request or a business tool performed an action.
 INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
 SELECT binding.tenant_id,consent_actor,'ai.principal.model_execution_authorized','job',p_job,
 jsonb_build_object('principalId',principal.id,'role',principal.role)
 WHERE NOT EXISTS(SELECT 1 FROM audit.records r WHERE r.tenant_id=binding.tenant_id
  AND r.target_id=p_job AND r.action='ai.principal.model_execution_authorized');
 RETURN jsonb_build_object('mode','principal','principalId',principal.id,
  'role',principal.role,'toolPermissions','[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION platform.admit_messaging_execution_principal(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.admit_messaging_execution_principal(uuid,text,uuid)
TO platform_messaging;
"""


def upgrade():
    tables, function = SQL.split("CREATE FUNCTION", 1)
    body, grants = function.split("END $$;", 1)
    for statement in tables.split(";"):
        if statement.strip():
            op.execute(statement)
    op.execute("CREATE FUNCTION" + body + "END $$;")
    for statement in grants.split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    op.execute("""DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM ops.ai_principal_alerts)
       OR EXISTS(SELECT 1 FROM platform.tenant_ai_execution_bindings WHERE enabled)
       OR EXISTS(SELECT 1 FROM platform.ai_execution_principals) THEN
       RAISE EXCEPTION 'ai_principal_evidence_or_binding_requires_reviewed_retention';
      END IF;
    END $$""")
    op.execute("DROP FUNCTION platform.admit_messaging_execution_principal(uuid,text,uuid)")
    op.execute("DROP TABLE ops.ai_principal_alerts")
    op.execute("ALTER TABLE ops.jobs DROP CONSTRAINT uq_jobs_principal_tenant_id")
    op.execute("DROP TABLE platform.tenant_ai_execution_bindings")
    op.execute("DROP TABLE platform.ai_execution_principals")
