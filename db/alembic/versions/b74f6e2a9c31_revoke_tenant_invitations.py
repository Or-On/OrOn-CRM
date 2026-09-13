"""revoke tenant invitations

Revision ID: b74f6e2a9c31
Revises: d41b2038c77a
Create Date: 2026-09-11 14:50:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "b74f6e2a9c31"
down_revision: str | None = "d41b2038c77a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION platform.revoke_current_tenant_invitation(
          p_invitation_id uuid, p_request_id text
        ) RETURNS boolean
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_actor uuid := platform.current_user_id();
                v_email text;
                v_role text;
        BEGIN
          IF v_tenant IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.tenants tenant
            WHERE tenant.id = v_tenant AND tenant.status = 'active'
          ) THEN
            RAISE EXCEPTION 'active tenant context required' USING ERRCODE = 'P0002';
          END IF;

          IF NOT EXISTS (
            SELECT 1
            FROM public.users actor
            LEFT JOIN public.memberships membership
              ON membership.user_id = actor.id
             AND membership.tenant_id = v_tenant
            WHERE actor.id = v_actor
              AND actor.status = 'active'
              AND (
                actor.is_superuser OR membership.role IN ('owner', 'admin')
              )
          ) THEN
            RAISE EXCEPTION 'member management permission required'
              USING ERRCODE = '42501';
          END IF;

          DELETE FROM platform.tenant_invitations invitation
          WHERE invitation.id = p_invitation_id
            AND invitation.tenant_id = v_tenant
            AND invitation.accepted_at IS NULL
          RETURNING invitation.email::text, invitation.role
          INTO v_email, v_role;

          IF NOT FOUND THEN
            RETURN false;
          END IF;

          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_actor, 'tenant.invitation.revoked',
            'tenant_invitation', p_invitation_id, p_request_id,
            jsonb_build_object('email', v_email, 'role', v_role)
          );
          RETURN true;
        END
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION platform.revoke_current_tenant_invitation(uuid,text) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "platform.revoke_current_tenant_invitation(uuid,text) TO platform_web"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.revoke_current_tenant_invitation(uuid,text)")
