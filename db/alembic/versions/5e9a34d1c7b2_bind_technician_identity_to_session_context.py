"""bind technician identity to authenticated session context

Revision ID: 5e9a34d1c7b2
Revises: f22c1b7e9a40
Create Date: 2026-09-15 16:30:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "5e9a34d1c7b2"
down_revision: str | None = "f22c1b7e9a40"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Application repositories must never select the private session table or
    # accept a browser/session identifier as mutation input. This deliberately
    # narrow function resolves only the transaction-local session established
    # by the authentication boundary, validates it against the current tenant,
    # user, and role, and locks the authorization rows through the write.
    op.execute("""
        CREATE FUNCTION service.lock_current_technician_session_context()
        RETURNS TABLE(session_id uuid, absolute_expires_at timestamptz)
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_user uuid := platform.current_user_id();
          v_session_setting text := current_setting('app.current_session', true);
          v_session uuid;
          v_context_role text := coalesce(
            current_setting('app.current_role', true), ''
          );
          v_member_role text;
          v_superuser boolean;
          v_idle_expires_at timestamptz;
          v_absolute_expires_at timestamptz;
        BEGIN
          IF v_session_setting IS NULL OR v_session_setting !~*
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN
            RETURN;
          END IF;
          v_session := v_session_setting::uuid;

          PERFORM 1
          FROM public.tenants tenant
          WHERE tenant.id = v_tenant AND tenant.status = 'active'
          FOR SHARE;
          IF NOT FOUND THEN RETURN; END IF;

          SELECT account.is_superuser
          INTO v_superuser
          FROM public.users account
          WHERE account.id = v_user AND account.status = 'active'
          FOR SHARE;
          IF NOT FOUND THEN RETURN; END IF;

          IF v_superuser THEN
            IF v_context_role IS DISTINCT FROM 'owner' THEN RETURN; END IF;
          ELSE
            SELECT CASE WHEN member.role = 'editor' THEN 'admin' ELSE member.role END
            INTO v_member_role
            FROM public.memberships member
            WHERE member.tenant_id = v_tenant AND member.user_id = v_user
            FOR SHARE;
            IF NOT FOUND OR v_member_role IS DISTINCT FROM v_context_role
              OR v_member_role NOT IN ('owner','admin','agent','technician')
            THEN
              RETURN;
            END IF;
          END IF;

          SELECT session.id, session.idle_expires_at, session.absolute_expires_at
          INTO session_id, v_idle_expires_at, v_absolute_expires_at
          FROM platform.auth_sessions session
          WHERE session.id = v_session
            AND session.user_id = v_user
            AND session.active_tenant_id = v_tenant
            AND session.revoked_at IS NULL
          FOR SHARE;
          IF NOT FOUND OR v_idle_expires_at <= clock_timestamp()
            OR v_absolute_expires_at <= clock_timestamp()
          THEN
            session_id := NULL;
            RETURN;
          END IF;

          absolute_expires_at := v_absolute_expires_at;
          RETURN NEXT;
        END
        $$
    """)
    op.execute(
        "REVOKE ALL ON FUNCTION service.lock_current_technician_session_context() FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "service.lock_current_technician_session_context() TO platform_web"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION service.lock_current_technician_session_context()")
