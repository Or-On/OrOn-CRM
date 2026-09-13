"""add user and tenant identity images

Revision ID: c92f8341a7de
Revises: ce2dff05c838
Create Date: 2026-09-11 17:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c92f8341a7de"
down_revision: str | None = "ce2dff05c838"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _secure_function(statement: str, signature: str) -> None:
    op.execute(statement)
    op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION {signature} TO platform_web")


def upgrade() -> None:
    op.add_column("users", sa.Column("avatar_data", sa.LargeBinary(), nullable=True))
    op.add_column("users", sa.Column("avatar_content_type", sa.Text(), nullable=True))
    op.add_column(
        "users", sa.Column("avatar_updated_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_check_constraint(
        "ck_users_avatar_payload",
        "users",
        "(avatar_data IS NULL AND avatar_content_type IS NULL) OR "
        "(avatar_data IS NOT NULL AND avatar_content_type IN "
        "('image/png', 'image/jpeg', 'image/webp') AND octet_length(avatar_data) <= 2097152)",
    )

    op.add_column(
        "tenant_settings", sa.Column("logo_data", sa.LargeBinary(), nullable=True), schema="crm"
    )
    op.add_column(
        "tenant_settings", sa.Column("logo_content_type", sa.Text(), nullable=True), schema="crm"
    )
    op.add_column(
        "tenant_settings",
        sa.Column("logo_updated_at", sa.DateTime(timezone=True), nullable=True),
        schema="crm",
    )
    op.create_check_constraint(
        "ck_tenant_settings_logo_payload",
        "tenant_settings",
        "(logo_data IS NULL AND logo_content_type IS NULL) OR "
        "(logo_data IS NOT NULL AND logo_content_type IN "
        "('image/png', 'image/jpeg', 'image/webp') AND octet_length(logo_data) <= 2097152)",
        schema="crm",
    )

    _secure_function(
        """
        CREATE FUNCTION platform.current_user_avatar()
        RETURNS TABLE(data bytea, content_type text, updated_at timestamptz)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT account.avatar_data, account.avatar_content_type, account.avatar_updated_at
          FROM public.users account
          WHERE account.id = platform.current_user_id()
            AND account.status = 'active' AND account.avatar_data IS NOT NULL
        $$
        """,
        "platform.current_user_avatar()",
    )
    _secure_function(
        """
        CREATE FUNCTION platform.set_current_user_avatar(
          p_data bytea, p_content_type text, p_request_id text
        ) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_user uuid := platform.current_user_id();
                v_tenant uuid := platform.current_tenant_id();
        BEGIN
          IF v_user IS NULL OR p_request_id IS NULL OR btrim(p_request_id) = '' OR
             ((p_data IS NULL) <> (p_content_type IS NULL)) OR
             (p_data IS NOT NULL AND (
               octet_length(p_data) > 2097152 OR
               p_content_type NOT IN ('image/png', 'image/jpeg', 'image/webp')
             )) THEN
            RAISE EXCEPTION 'invalid avatar image' USING ERRCODE = '22023';
          END IF;
          UPDATE public.users account
          SET avatar_data = p_data, avatar_content_type = p_content_type,
              avatar_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE account.id = v_user AND account.status = 'active';
          IF NOT FOUND THEN
            RAISE EXCEPTION 'active account required' USING ERRCODE = '42501';
          END IF;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_user,
            CASE WHEN p_data IS NULL THEN 'account.avatar.removed'
              ELSE 'account.avatar.updated' END,
            'user', v_user, p_request_id,
            jsonb_build_object(
              'content_type', p_content_type, 'bytes', coalesce(octet_length(p_data), 0))
          );
        END
        $$
        """,
        "platform.set_current_user_avatar(bytea,text,text)",
    )
    _secure_function(
        """
        CREATE FUNCTION platform.current_tenant_logo()
        RETURNS TABLE(data bytea, content_type text, updated_at timestamptz)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT settings.logo_data, settings.logo_content_type, settings.logo_updated_at
          FROM crm.tenant_settings settings
          WHERE settings.tenant_id = platform.current_tenant_id()
            AND settings.logo_data IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.users account
              LEFT JOIN public.memberships membership
                ON membership.user_id = account.id
               AND membership.tenant_id = settings.tenant_id
              WHERE account.id = platform.current_user_id() AND account.status = 'active'
                AND (account.is_superuser OR membership.user_id IS NOT NULL)
            )
        $$
        """,
        "platform.current_tenant_logo()",
    )
    _secure_function(
        """
        CREATE FUNCTION platform.set_current_tenant_logo(
          p_data bytea, p_content_type text, p_request_id text
        ) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_user uuid := platform.current_user_id();
                v_tenant uuid := platform.current_tenant_id();
        BEGIN
          IF v_tenant IS NULL OR p_request_id IS NULL OR btrim(p_request_id) = '' OR
             ((p_data IS NULL) <> (p_content_type IS NULL)) OR
             (p_data IS NOT NULL AND (
               octet_length(p_data) > 2097152 OR
               p_content_type NOT IN ('image/png', 'image/jpeg', 'image/webp')
             )) THEN
            RAISE EXCEPTION 'invalid organization logo' USING ERRCODE = '22023';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM public.users account
            LEFT JOIN public.memberships membership
              ON membership.user_id = account.id AND membership.tenant_id = v_tenant
            WHERE account.id = v_user AND account.status = 'active'
              AND (account.is_superuser OR membership.role IN ('owner', 'admin', 'editor'))
          ) THEN
            RAISE EXCEPTION 'tenant management permission required' USING ERRCODE = '42501';
          END IF;
          INSERT INTO crm.tenant_settings(
            tenant_id, logo_data, logo_content_type, logo_updated_at
          ) VALUES (v_tenant, p_data, p_content_type, CURRENT_TIMESTAMP)
          ON CONFLICT (tenant_id) DO UPDATE
          SET logo_data = EXCLUDED.logo_data,
              logo_content_type = EXCLUDED.logo_content_type,
              logo_updated_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_user,
            CASE WHEN p_data IS NULL THEN 'tenant.logo.removed' ELSE 'tenant.logo.updated' END,
            'tenant', v_tenant, p_request_id,
            jsonb_build_object(
              'content_type', p_content_type, 'bytes', coalesce(octet_length(p_data), 0))
          );
        END
        $$
        """,
        "platform.set_current_tenant_logo(bytea,text,text)",
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.set_current_tenant_logo(bytea,text,text)")
    op.execute("DROP FUNCTION platform.current_tenant_logo()")
    op.execute("DROP FUNCTION platform.set_current_user_avatar(bytea,text,text)")
    op.execute("DROP FUNCTION platform.current_user_avatar()")
    op.drop_constraint(
        "ck_tenant_settings_logo_payload", "tenant_settings", schema="crm", type_="check"
    )
    op.drop_column("tenant_settings", "logo_updated_at", schema="crm")
    op.drop_column("tenant_settings", "logo_content_type", schema="crm")
    op.drop_column("tenant_settings", "logo_data", schema="crm")
    op.drop_constraint("ck_users_avatar_payload", "users", type_="check")
    op.drop_column("users", "avatar_updated_at")
    op.drop_column("users", "avatar_content_type")
    op.drop_column("users", "avatar_data")
