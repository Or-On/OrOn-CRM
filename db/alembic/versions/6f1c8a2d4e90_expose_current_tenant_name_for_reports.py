"""expose current tenant name for report snapshots

Revision ID: 6f1c8a2d4e90
Revises: 5e9a34d1c7b2
Create Date: 2026-09-15 17:15:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "6f1c8a2d4e90"
down_revision: str | None = "5e9a34d1c7b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Tenant records remain private to application roles. Finalized service
    # reports need only the active tenant's name as a branding fallback, so
    # expose that single value from transaction-local authorization context
    # instead of granting platform_web access to public.tenants.
    op.execute("""
        CREATE FUNCTION platform.current_tenant_name()
        RETURNS text
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT tenant.name::text
          FROM public.tenants tenant
          WHERE tenant.id = platform.current_tenant_id()
            AND tenant.status = 'active'
            AND EXISTS (
              SELECT 1
              FROM public.users actor
              LEFT JOIN public.memberships membership
                ON membership.user_id = actor.id
               AND membership.tenant_id = tenant.id
              WHERE actor.id = platform.current_user_id()
                AND actor.status = 'active'
                AND (
                  actor.is_superuser
                  OR membership.user_id IS NOT NULL
                )
            )
          LIMIT 1
        $$
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.current_tenant_name() FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION platform.current_tenant_name() TO platform_web")


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.current_tenant_name()")
