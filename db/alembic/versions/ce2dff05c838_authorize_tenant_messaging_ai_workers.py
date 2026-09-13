"""authorize tenant messaging ai workers

Revision ID: ce2dff05c838
Revises: b74f6e2a9c31
Create Date: 2026-09-11 15:29:48.288512
"""

from collections.abc import Sequence

from alembic import op

revision: str = "ce2dff05c838"
down_revision: str | None = "b74f6e2a9c31"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The messaging worker must revalidate the operator who enabled AI after
    # work has spent time in the durable queue. Keep identity tables private
    # and expose only this boolean authorization decision.
    op.execute(
        """
        CREATE FUNCTION platform.messaging_ai_actor_authorized(p_actor uuid)
        RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT EXISTS (
            SELECT 1
            FROM public.users actor
            JOIN public.tenants tenant
              ON tenant.id = platform.current_tenant_id()
             AND tenant.status = 'active'
            LEFT JOIN public.memberships membership
              ON membership.tenant_id = tenant.id
             AND membership.user_id = actor.id
            WHERE actor.id = p_actor
              AND actor.status = 'active'
              AND (
                actor.is_superuser
                OR membership.role IN ('owner', 'admin', 'editor', 'agent')
              )
          )
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION platform.messaging_ai_actor_authorized(uuid) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.messaging_ai_actor_authorized(uuid) "
        "TO platform_messaging"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.messaging_ai_actor_authorized(uuid)")
