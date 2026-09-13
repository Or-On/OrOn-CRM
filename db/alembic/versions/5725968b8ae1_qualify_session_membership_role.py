"""qualify session membership role

Revision ID: 5725968b8ae1
Revises: c567208f57bc
Create Date: 2026-09-09 16:29:00.000000
"""

# ruff: noqa: S608 -- both interpolations are fixed migration-owned identifiers.

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5725968b8ae1"
down_revision: str | None = "c567208f57bc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _replace_resolver(*, qualify_role: bool) -> None:
    membership_role = "membership.role" if qualify_role else "role"
    op.execute(
        # Both substitutions are fixed SQL identifiers selected above; no
        # runtime or user-controlled value reaches this migration statement.
        sa.text(f"""
        CREATE OR REPLACE FUNCTION platform.auth_resolve_session(p_token_hash bytea)
        RETURNS TABLE(
          session_id uuid, user_id uuid, email citext, display_name text,
          is_superuser boolean, tenant_id uuid, tenant_name text,
          tenant_slug text, role text, csrf_token_hash bytea,
          absolute_expires_at timestamptz, rotation_count integer
        )
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform
        AS $$
        BEGIN
          RETURN QUERY
          UPDATE platform.auth_sessions s
          SET last_seen_at = CURRENT_TIMESTAMP,
              idle_expires_at = LEAST(
                s.absolute_expires_at,
                CURRENT_TIMESTAMP + make_interval(secs => s.idle_timeout_seconds)
              )
          FROM public.users u, public.tenants t
          WHERE s.token_hash = p_token_hash
            AND s.revoked_at IS NULL
            AND s.idle_expires_at > CURRENT_TIMESTAMP
            AND s.absolute_expires_at > CURRENT_TIMESTAMP
            AND u.id = s.user_id AND u.status = 'active'
            AND t.id = s.active_tenant_id AND t.status = 'active'
            AND (
              u.is_superuser OR EXISTS (
                SELECT 1 FROM public.memberships access_membership
                WHERE access_membership.user_id = u.id
                  AND access_membership.tenant_id = t.id
              )
            )
          RETURNING s.id, s.user_id, u.email, u.display_name, u.is_superuser,
                    s.active_tenant_id, t.name::text, t.slug::text,
                    CASE
                      WHEN u.is_superuser THEN 'owner'
                      ELSE (
                        SELECT CASE
                          WHEN {membership_role} = 'editor' THEN 'admin'
                          ELSE {membership_role}
                        END
                        FROM public.memberships membership
                        WHERE membership.user_id = u.id
                          AND membership.tenant_id = t.id
                      )
                    END::text,
                    s.csrf_token_hash, s.absolute_expires_at, s.rotation_count;
        END
        $$
        """)
    )
    op.execute("REVOKE ALL ON FUNCTION platform.auth_resolve_session(bytea) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION platform.auth_resolve_session(bytea) TO platform_web")


def upgrade() -> None:
    # The return column is also named ``role``. Qualifying the membership field
    # avoids PL/pgSQL's variable/column ambiguity for non-superuser sessions.
    _replace_resolver(qualify_role=True)


def downgrade() -> None:
    _replace_resolver(qualify_role=False)
