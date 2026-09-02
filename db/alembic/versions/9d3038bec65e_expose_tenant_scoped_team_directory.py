"""expose tenant scoped team directory

Revision ID: 9d3038bec65e
Revises: a1a71d1f7a03
Create Date: 2026-09-02 21:38:25.641608
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "9d3038bec65e"
down_revision: str | None = "a1a71d1f7a03"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Identity tables remain private. Expose only the active tenant's directory
    # after checking the authenticated actor's current membership in PostgreSQL.
    op.execute(
        sa.text("""
        CREATE FUNCTION platform.current_tenant_team()
        RETURNS TABLE(user_id uuid, email text, role text)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT member.user_id, account.email::text,
                 CASE WHEN member.role = 'editor' THEN 'admin' ELSE member.role END::text
          FROM public.memberships member
          JOIN public.users account ON account.id = member.user_id
          JOIN public.tenants tenant ON tenant.id = member.tenant_id
          WHERE member.tenant_id = platform.current_tenant_id()
            AND account.status = 'active' AND tenant.status = 'active'
            AND member.role IN ('owner', 'admin', 'editor', 'agent', 'viewer')
            AND EXISTS (
              SELECT 1 FROM public.memberships actor_membership
              JOIN public.users actor ON actor.id = actor_membership.user_id
              WHERE actor_membership.tenant_id = member.tenant_id
                AND actor_membership.user_id = platform.current_user_id()
                AND actor_membership.role IN ('owner', 'admin', 'editor', 'agent', 'viewer')
                AND actor.status = 'active'
            )
        $$
        """)
    )
    op.execute("REVOKE ALL ON FUNCTION platform.current_tenant_team() FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION platform.current_tenant_team() TO platform_web")


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.current_tenant_team()")
