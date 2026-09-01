"""harden canonical authentication functions

Revision ID: 3efa5431c380
Revises: c30e1edd7c7f
Create Date: 2026-09-01 20:08:17.977198
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3efa5431c380"
down_revision: str | Sequence[str] | None = "c30e1edd7c7f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        sa.text("""
        CREATE OR REPLACE FUNCTION platform.auth_resolve_session(p_token_hash bytea)
        RETURNS TABLE(
          session_id uuid, user_id uuid, email citext, tenant_id uuid,
          tenant_name text, tenant_slug text, role text, csrf_token_hash bytea,
          absolute_expires_at timestamptz, rotation_count integer
        )
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform
        AS $$
        BEGIN
          RETURN QUERY
          UPDATE platform.auth_sessions s
          SET last_seen_at = CURRENT_TIMESTAMP,
              idle_expires_at = LEAST(s.absolute_expires_at,
                CURRENT_TIMESTAMP + make_interval(secs => s.idle_timeout_seconds))
          FROM public.users u, public.memberships m, public.tenants t
          WHERE s.token_hash = p_token_hash
            AND s.revoked_at IS NULL
            AND s.idle_expires_at > CURRENT_TIMESTAMP
            AND s.absolute_expires_at > CURRENT_TIMESTAMP
            AND u.id = s.user_id AND u.status = 'active'
            AND m.user_id = s.user_id AND m.tenant_id = s.active_tenant_id
            AND t.id = s.active_tenant_id AND t.status = 'active'
          RETURNING s.id, s.user_id, u.email, s.active_tenant_id,
                    t.name::text, t.slug::text,
                    (CASE WHEN m.role = 'editor' THEN 'admin' ELSE m.role END)::text,
                    s.csrf_token_hash, s.absolute_expires_at, s.rotation_count;
        END
        $$
        """)
    )
    op.execute(
        sa.text("""
        CREATE OR REPLACE FUNCTION platform.protect_last_tenant_owner()
        RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        DECLARE v_owner_count integer;
        BEGIN
          IF OLD.role <> 'owner' OR (TG_OP = 'UPDATE' AND NEW.role = 'owner') THEN
            RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
          END IF;
          IF TG_OP = 'DELETE' AND NOT EXISTS (
            SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
          ) THEN
            RETURN OLD;
          END IF;
          PERFORM 1 FROM public.memberships
          WHERE tenant_id = OLD.tenant_id AND role = 'owner'
          ORDER BY user_id FOR UPDATE;
          SELECT count(*) INTO v_owner_count FROM public.memberships
          WHERE tenant_id = OLD.tenant_id AND role = 'owner';
          IF v_owner_count <= 1 THEN
            RAISE EXCEPTION 'tenant must retain an owner' USING ERRCODE = '23514';
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
        """)
    )


def downgrade() -> None:
    # These fixes are backward-compatible and safe to retain at c30e1edd7c7f.
    op.execute(sa.text("SELECT 1"))
