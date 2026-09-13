"""lock fresh auth authorization before protected writes

Revision ID: bfb741c767fd
Revises: 74e4f347dbbd
Create Date: 2026-09-12 20:21:10.579765
"""

from collections.abc import Sequence

from alembic import op

revision: str = "bfb741c767fd"
down_revision: str | None = "74e4f347dbbd"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE FUNCTION platform.lock_current_authorization(
          p_session_id uuid,p_expected_role text,p_expected_superuser boolean,
          p_rotation_count integer
        ) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path=pg_catalog AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_user uuid := platform.current_user_id();
                v_superuser boolean; v_role text;
                v_idle timestamptz; v_absolute timestamptz;
        BEGIN
          -- Match deletion lock order: tenant before all subordinate authorization
          -- rows. Hold locks until the protected write commits, not across HTTP.
          PERFORM 1 FROM public.tenants WHERE id=v_tenant AND status='active' FOR SHARE;
          IF NOT FOUND THEN RETURN false; END IF;
          SELECT is_superuser INTO v_superuser FROM public.users
            WHERE id=v_user AND status='active' FOR SHARE;
          IF NOT FOUND OR v_superuser IS DISTINCT FROM p_expected_superuser THEN
            RETURN false;
          END IF;
          IF v_superuser THEN v_role := 'owner';
          ELSE
            SELECT CASE WHEN role='editor' THEN 'admin' ELSE role END INTO v_role
            FROM public.memberships WHERE tenant_id=v_tenant AND user_id=v_user FOR SHARE;
            IF NOT FOUND THEN RETURN false; END IF;
          END IF;
          IF v_role IS DISTINCT FROM p_expected_role OR v_role NOT IN
             ('owner','admin','agent','viewer') THEN RETURN false; END IF;
          SELECT idle_expires_at,absolute_expires_at INTO v_idle,v_absolute
          FROM platform.auth_sessions
          WHERE id=p_session_id AND user_id=v_user AND active_tenant_id=v_tenant
            AND revoked_at IS NULL AND rotation_count=p_rotation_count
          FOR SHARE;
          -- Evaluate expiry after any lock wait, not at transaction start.
          RETURN FOUND AND v_idle>clock_timestamp() AND v_absolute>clock_timestamp();
        END $$
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION platform.lock_current_authorization(uuid,text,boolean,integer)
          FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION platform.lock_current_authorization(uuid,text,boolean,integer)
          TO platform_web
    """)


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.lock_current_authorization(uuid,text,boolean,integer)")
