"""harden tenant administration access

Revision ID: e139bf3fde7e
Revises: 5725968b8ae1
Create Date: 2026-09-09 17:09:54.819103
"""

# ruff: noqa: S608 -- interpolations are fixed migration-owned SQL fragments.

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e139bf3fde7e"
down_revision: str | None = "5725968b8ae1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _secure_web_function(sql: str, signature: str) -> None:
    op.execute(sa.text(sql))
    op.execute(sa.text(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC"))
    op.execute(sa.text(f"GRANT EXECUTE ON FUNCTION {signature} TO platform_web"))


def _replace_tenant_name_function(*, require_active_tenant: bool) -> None:
    active_tenant_guard = (
        """
          IF v_tenant IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.tenants tenant
            WHERE tenant.id = v_tenant AND tenant.status = 'active'
          ) THEN
            RAISE EXCEPTION 'active tenant context required' USING ERRCODE = 'P0002';
          END IF;
    """
        if require_active_tenant
        else ""
    )

    _secure_web_function(
        f"""
        CREATE OR REPLACE FUNCTION platform.update_current_tenant_name(
          p_name text, p_request_id text
        ) RETURNS text
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, audit
        AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_actor uuid := platform.current_user_id();
                v_name text := btrim(p_name);
        BEGIN
{active_tenant_guard}
          IF length(v_name) < 2 OR length(v_name) > 120 THEN
            RAISE EXCEPTION 'tenant name must contain between 2 and 120 characters'
              USING ERRCODE = '22023';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM public.users u
            LEFT JOIN public.memberships m
              ON m.user_id = u.id AND m.tenant_id = v_tenant
            WHERE u.id = v_actor AND u.status = 'active'
              AND (u.is_superuser OR m.role IN ('owner', 'admin', 'editor'))
          ) THEN
            RAISE EXCEPTION 'tenant management permission required' USING ERRCODE = '42501';
          END IF;
          UPDATE public.tenants SET name = v_name, updated_at = CURRENT_TIMESTAMP
          WHERE id = v_tenant AND status = 'active';
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_actor, 'tenant.name.updated', 'tenant', v_tenant,
            p_request_id, '{{}}'::jsonb
          );
          RETURN v_name;
        END
        $$
        """,
        "platform.update_current_tenant_name(text,text)",
    )


def upgrade() -> None:
    _secure_web_function(
        """
        CREATE FUNCTION platform.current_tenant_invitations()
        RETURNS TABLE(
          id uuid, email citext, role text, expires_at timestamptz,
          created_at timestamptz
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT invitation.id, invitation.email, invitation.role,
                 invitation.expires_at, invitation.created_at
          FROM platform.tenant_invitations invitation
          JOIN public.tenants tenant ON tenant.id = invitation.tenant_id
          WHERE invitation.tenant_id = platform.current_tenant_id()
            AND invitation.accepted_at IS NULL
            AND invitation.expires_at > CURRENT_TIMESTAMP
            AND tenant.status = 'active'
            AND EXISTS (
              SELECT 1
              FROM public.users actor
              LEFT JOIN public.memberships membership
                ON membership.user_id = actor.id
               AND membership.tenant_id = invitation.tenant_id
              WHERE actor.id = platform.current_user_id()
                AND actor.status = 'active'
                AND (
                  actor.is_superuser OR
                  membership.role IN ('owner', 'admin', 'editor')
                )
            )
          ORDER BY invitation.created_at DESC, invitation.id DESC
        $$
        """,
        "platform.current_tenant_invitations()",
    )
    op.execute(
        "REVOKE SELECT, INSERT, UPDATE, DELETE ON platform.tenant_invitations FROM platform_web"
    )
    _replace_tenant_name_function(require_active_tenant=True)


def downgrade() -> None:
    _replace_tenant_name_function(require_active_tenant=False)
    op.execute("DROP FUNCTION platform.current_tenant_invitations()")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON platform.tenant_invitations TO platform_web"
    )
