"""expose tenant feature change actor safely

Revision ID: d4e15a9c7b02
Revises: b72c5f0e4d91
Create Date: 2026-09-15 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e15a9c7b02"
down_revision: str | None = "b72c5f0e4d91"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Identity tables stay private. Feature-state readers need only the display
    # name of a changer who belongs to the active tenant, never arbitrary user
    # records. Service workers have a trusted tenant context but no human actor.
    op.execute(
        sa.text("""
        CREATE FUNCTION platform.current_tenant_member_display_name(p_user_id uuid)
        RETURNS text
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT account.display_name
          FROM public.memberships member
          JOIN public.users account ON account.id = member.user_id
          JOIN public.tenants tenant ON tenant.id = member.tenant_id
          WHERE member.tenant_id = platform.current_tenant_id()
            AND member.user_id = p_user_id
            AND account.status = 'active'
            AND tenant.status = 'active'
            AND (
              coalesce(current_setting('app.current_role', true), '') = 'service'
              OR EXISTS (
                SELECT 1
                FROM public.users actor
                LEFT JOIN public.memberships actor_membership
                  ON actor_membership.user_id = actor.id
                 AND actor_membership.tenant_id = member.tenant_id
                WHERE actor.id = platform.current_user_id()
                  AND actor.status = 'active'
                  AND (
                    actor.is_superuser
                    OR actor_membership.user_id IS NOT NULL
                  )
              )
            )
          LIMIT 1
        $$
        """)
    )
    op.execute(
        "REVOKE ALL ON FUNCTION platform.current_tenant_member_display_name(uuid) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "platform.current_tenant_member_display_name(uuid) "
        "TO platform_web, platform_worker"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.current_tenant_member_display_name(uuid)")
