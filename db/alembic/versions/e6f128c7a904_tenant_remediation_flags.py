"""Tenant-scoped opt-in switches for reviewed remediation rollouts.

Revision ID: e6f128c7a904
Revises: d53170e04c62
"""

from alembic import op

revision = "e6f128c7a904"
down_revision = "d53170e04c62"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
      CREATE TABLE platform.tenant_remediation_flags (
        tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
        flag_key text NOT NULL CHECK(flag_key IN (
          'no_silence','queue_priority','exclude_ai_memory','typing',
          'session_memory','retrieval_fts','handoff_resume','debounce')),
        enabled boolean NOT NULL DEFAULT false,
        changed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(tenant_id,flag_key)
      )
    """)
    op.execute("ALTER TABLE platform.tenant_remediation_flags ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE platform.tenant_remediation_flags FORCE ROW LEVEL SECURITY")
    op.execute("""
      CREATE POLICY tenant_remediation_flags_isolation ON platform.tenant_remediation_flags
      USING(tenant_id=platform.current_tenant_id())
      WITH CHECK(tenant_id=platform.current_tenant_id())
    """)
    op.execute("""
      GRANT SELECT ON platform.tenant_remediation_flags TO platform_web,platform_messaging,
        platform_voice,platform_worker
    """)
    op.execute("""
      CREATE FUNCTION platform.set_tenant_remediation_flag(p_key text,p_enabled boolean)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id
          JOIN public.tenants t ON t.id=m.tenant_id
          WHERE m.tenant_id=platform.current_tenant_id()
            AND m.user_id=platform.current_user_id() AND m.role IN ('owner','admin')
            AND u.status='active' AND t.status='active') THEN
          RAISE EXCEPTION 'remediation flag permission denied' USING ERRCODE='42501';
        END IF;
        IF p_enabled IS NULL THEN
          RAISE EXCEPTION 'flag state required' USING ERRCODE='22023';
        END IF;
        INSERT INTO platform.tenant_remediation_flags(
          tenant_id,flag_key,enabled,changed_by_user_id)
          VALUES(platform.current_tenant_id(),p_key,p_enabled,platform.current_user_id())
          ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled,
            changed_by_user_id=EXCLUDED.changed_by_user_id,updated_at=clock_timestamp();
        INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,metadata)
          VALUES(platform.current_tenant_id(),platform.current_user_id(),
            'remediation.flag_changed','tenant',jsonb_build_object('flag',p_key,'enabled',p_enabled));
        RETURN p_enabled;
      END $$
    """)
    op.execute(
        "REVOKE ALL ON FUNCTION platform.set_tenant_remediation_flag(text,boolean) FROM PUBLIC"
    )
    op.execute("""
      GRANT EXECUTE ON FUNCTION platform.set_tenant_remediation_flag(text,boolean) TO platform_web
    """)


def downgrade():
    op.execute("DROP FUNCTION platform.set_tenant_remediation_flag(text,boolean)")
    op.execute("DROP TABLE platform.tenant_remediation_flags")
