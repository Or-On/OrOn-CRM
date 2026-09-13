"""add guarded tenant deletion

Revision ID: eb2660eb37ec
Revises: 39862f055865
Create Date: 2026-09-12 19:15:06.023681
"""

from collections.abc import Sequence

from alembic import op

revision: str = "eb2660eb37ec"
down_revision: str | None = "39862f055865"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION platform.delete_tenant_for_administrator(
          p_tenant_id uuid, p_request_id text
        ) RETURNS boolean
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE
          v_actor uuid := nullif(current_setting('app.current_user', true), '')::uuid;
          v_current_tenant uuid :=
            nullif(current_setting('app.current_tenant', true), '')::uuid;
          v_slug text;
          v_cancelled_jobs integer := 0;
          v_cancelled_messages integer := 0;
          v_revoked_invitations integer := 0;
        BEGIN
          IF v_actor IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.users actor
            WHERE actor.id = v_actor
              AND actor.is_superuser
              AND actor.status = 'active'
          ) THEN
            RAISE EXCEPTION 'platform administrator required'
              USING ERRCODE = '42501';
          END IF;

          SELECT tenant.slug::text INTO v_slug
          FROM public.tenants tenant
          WHERE tenant.id = p_tenant_id AND tenant.status = 'active'
          FOR UPDATE;
          IF NOT FOUND THEN
            RETURN false;
          END IF;
          IF p_tenant_id = v_current_tenant THEN
            RAISE EXCEPTION 'switch away from the tenant before deleting it'
              USING ERRCODE = '22023';
          END IF;
          IF (SELECT count(*) FROM public.tenants WHERE status = 'active') <= 1 THEN
            RAISE EXCEPTION 'the final active tenant cannot be deleted'
              USING ERRCODE = '22023';
          END IF;

          -- Stop work that has not started. If a provider operation is already
          -- in flight, fail closed and require the administrator to retry after
          -- it reaches a terminal state.
          UPDATE ops.jobs
          SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP,
              locked_at = NULL, locked_by = NULL,
              last_error_safe = 'Tenant deleted by platform administrator',
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = p_tenant_id AND status IN ('queued', 'retry');
          GET DIAGNOSTICS v_cancelled_jobs = ROW_COUNT;

          WITH stopped AS (
            UPDATE messaging.outbound_requests
            SET status = 'failed', last_error_code = 'tenant_deleted',
                completed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = p_tenant_id AND status = 'queued'
            RETURNING message_id
          )
          UPDATE messaging.messages message
          SET status = 'failed', updated_at = CURRENT_TIMESTAMP
          WHERE message.tenant_id = p_tenant_id
            AND message.id IN (SELECT message_id FROM stopped)
            AND message.status IN ('pending', 'queued');
          GET DIAGNOSTICS v_cancelled_messages = ROW_COUNT;

          IF EXISTS (
            SELECT 1 FROM ops.jobs
            WHERE tenant_id = p_tenant_id AND status = 'running'
          ) OR EXISTS (
            SELECT 1 FROM messaging.outbound_requests
            WHERE tenant_id = p_tenant_id AND status = 'sending'
          ) OR EXISTS (
            SELECT 1 FROM public.sessions
            WHERE tenant_id = p_tenant_id AND ended_at IS NULL
          ) THEN
            RAISE EXCEPTION 'tenant has active provider or session work'
              USING ERRCODE = '55006';
          END IF;

          UPDATE messaging.channels
          SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = p_tenant_id AND status <> 'revoked';

          DELETE FROM platform.tenant_invitations
          WHERE tenant_id = p_tenant_id AND accepted_at IS NULL;
          GET DIAGNOSTICS v_revoked_invitations = ROW_COUNT;

          UPDATE platform.auth_sessions
          SET revoked_at = CURRENT_TIMESTAMP,
              revocation_reason = 'tenant_deleted'
          WHERE active_tenant_id = p_tenant_id AND revoked_at IS NULL;

          UPDATE public.tenants
          SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
          WHERE id = p_tenant_id;

          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            p_tenant_id, v_actor, 'tenant.deleted', 'tenant', p_tenant_id,
            p_request_id,
            jsonb_build_object(
              'slug', v_slug,
              'cancelled_jobs', v_cancelled_jobs,
              'cancelled_messages', v_cancelled_messages,
              'revoked_invitations', v_revoked_invitations,
              'deletion_mode', 'retained_for_audit'
            )
          );
          RETURN true;
        END
        $$
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION platform.delete_tenant_for_administrator(uuid,text) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "platform.delete_tenant_for_administrator(uuid,text) TO platform_web"
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION platform.list_tenants_for_administrator()
        RETURNS TABLE(
          id uuid, name text, slug text, status text, default_currency text,
          locale text, timezone text, member_count bigint, created_at timestamptz
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT tenant.id, tenant.name::text, tenant.slug::text, tenant.status::text,
                 settings.default_currency::text, settings.locale::text,
                 settings.timezone::text, count(membership.user_id), tenant.created_at
          FROM public.tenants tenant
          JOIN crm.tenant_settings settings ON settings.tenant_id = tenant.id
          LEFT JOIN public.memberships membership ON membership.tenant_id = tenant.id
          WHERE tenant.status <> 'deleted' AND EXISTS (
            SELECT 1 FROM public.users actor
            WHERE actor.id = nullif(current_setting('app.current_user', true), '')::uuid
              AND actor.is_superuser AND actor.status = 'active'
          )
          GROUP BY tenant.id, settings.default_currency, settings.locale, settings.timezone
          ORDER BY tenant.created_at DESC, tenant.id DESC
        $$
        """
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.delete_tenant_for_administrator(uuid,text)")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION platform.list_tenants_for_administrator()
        RETURNS TABLE(
          id uuid, name text, slug text, status text, default_currency text,
          locale text, timezone text, member_count bigint, created_at timestamptz
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT tenant.id, tenant.name::text, tenant.slug::text, tenant.status::text,
                 settings.default_currency::text, settings.locale::text,
                 settings.timezone::text, count(membership.user_id), tenant.created_at
          FROM public.tenants tenant
          JOIN crm.tenant_settings settings ON settings.tenant_id = tenant.id
          LEFT JOIN public.memberships membership ON membership.tenant_id = tenant.id
          WHERE EXISTS (
            SELECT 1 FROM public.users actor
            WHERE actor.id = nullif(current_setting('app.current_user', true), '')::uuid
              AND actor.is_superuser AND actor.status = 'active'
          )
          GROUP BY tenant.id, settings.default_currency, settings.locale, settings.timezone
          ORDER BY tenant.created_at DESC, tenant.id DESC
        $$
        """
    )
