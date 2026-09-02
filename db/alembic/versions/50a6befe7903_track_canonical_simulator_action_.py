"""track canonical simulator action completion

Revision ID: 50a6befe7903
Revises: 3f6133842389
Create Date: 2026-09-02 23:12:15.961335
"""

from collections.abc import Sequence

from alembic import op

revision: str = "50a6befe7903"
down_revision: str | None = "3f6133842389"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE FUNCTION platform.canonical_actor_authorized() RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
          SELECT EXISTS (
            SELECT 1 FROM public.memberships m JOIN public.users u ON u.id=m.user_id
            JOIN public.tenants t ON t.id=m.tenant_id
            WHERE m.tenant_id=platform.current_tenant_id() AND m.user_id=platform.current_user_id()
              AND m.role IN ('owner','admin','editor') AND u.status='active' AND t.status='active'
          )
        $$
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.canonical_actor_authorized() FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.canonical_actor_authorized() "
        "TO platform_web, platform_messaging"
    )
    op.execute("""
        CREATE FUNCTION platform.voice_flow_available(p_id uuid, p_version integer) RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
          SELECT platform.canonical_actor_authorized() AND EXISTS (
            SELECT 1 FROM public.flows WHERE flow_id=p_id AND version=p_version
              AND (tenant_id=platform.current_tenant_id() OR tenant_id IS NULL)
          )
        $$
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.voice_flow_available(uuid, integer) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.voice_flow_available(uuid, integer) "
        "TO platform_web, platform_messaging"
    )
    op.execute("GRANT USAGE ON SCHEMA automation, audit TO platform_messaging")
    op.execute("GRANT INSERT ON audit.records TO platform_messaging")
    op.execute(
        "GRANT SELECT ON automation.flow_definitions, automation.flow_versions "
        "TO platform_messaging"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON automation.flow_runs, automation.flow_step_runs, "
        "automation.handoffs TO platform_messaging"
    )
    op.execute(
        "CREATE INDEX ix_flow_run_simulation_key ON automation.flow_runs "
        "(tenant_id, ((trigger_metadata->>'idempotencyKey'))) "
        "WHERE trigger_type='canonical.simulator'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX automation.ix_flow_run_simulation_key")
    op.execute("REVOKE INSERT ON audit.records FROM platform_messaging")
    op.execute(
        "REVOKE SELECT, INSERT, UPDATE ON automation.flow_runs, automation.flow_step_runs, "
        "automation.handoffs FROM platform_messaging"
    )
    op.execute(
        "REVOKE SELECT ON automation.flow_definitions, automation.flow_versions "
        "FROM platform_messaging"
    )
    op.execute("REVOKE USAGE ON SCHEMA automation, audit FROM platform_messaging")
    op.execute("DROP FUNCTION platform.voice_flow_available(uuid, integer)")
    op.execute("DROP FUNCTION platform.canonical_actor_authorized()")
