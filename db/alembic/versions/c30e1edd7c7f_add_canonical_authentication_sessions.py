"""add canonical authentication sessions

Revision ID: c30e1edd7c7f
Revises: f5e8b540dfeb
Create Date: 2026-09-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c30e1edd7c7f"
down_revision: str | None = "f5e8b540dfeb"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _security_function(sql: str, signature: str) -> None:
    op.execute(sa.text(sql))
    op.execute(sa.text(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC"))
    op.execute(sa.text(f"GRANT EXECUTE ON FUNCTION {signature} TO platform_web"))


def upgrade() -> None:
    op.create_table(
        "auth_credentials",
        sa.Column(
            "user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("algorithm", sa.Text(), nullable=False, server_default="argon2id"),
        sa.Column("failed_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "password_changed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint("algorithm = 'argon2id'", name="ck_auth_credentials_algorithm"),
        sa.CheckConstraint("failed_attempts >= 0", name="ck_auth_credentials_failed_attempts"),
        schema="platform",
    )

    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "active_tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False),
        sa.Column("csrf_token_hash", sa.LargeBinary(), nullable=False),
        sa.Column("idle_timeout_seconds", sa.Integer(), nullable=False, server_default="43200"),
        sa.Column("rotation_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("user_agent_hash", sa.LargeBinary(), nullable=True),
        sa.Column("ip_hash", sa.LargeBinary(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("idle_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("absolute_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revocation_reason", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "idle_timeout_seconds BETWEEN 300 AND 86400", name="ck_auth_session_idle"
        ),
        sa.CheckConstraint("rotation_count >= 0", name="ck_auth_session_rotation"),
        sa.CheckConstraint("absolute_expires_at > created_at", name="ck_auth_session_absolute"),
        sa.CheckConstraint("idle_expires_at <= absolute_expires_at", name="ck_auth_session_expiry"),
        sa.CheckConstraint(
            "(revoked_at IS NULL AND revocation_reason IS NULL) OR revoked_at IS NOT NULL",
            name="ck_auth_session_revocation",
        ),
        sa.UniqueConstraint("token_hash", name="uq_auth_session_token_hash"),
        schema="platform",
    )
    op.create_index(
        "ix_auth_sessions_user_active",
        "auth_sessions",
        ["user_id", sa.text("last_seen_at DESC"), sa.text("id DESC")],
        schema="platform",
        postgresql_where=sa.text("revoked_at IS NULL"),
    )
    op.create_index(
        "ix_auth_sessions_expiry",
        "auth_sessions",
        ["idle_expires_at", "absolute_expires_at"],
        schema="platform",
        postgresql_where=sa.text("revoked_at IS NULL"),
    )

    op.create_table(
        "auth_one_time_tokens",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("tenant_id", sa.UUID(), nullable=True),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "purpose IN ('invitation', 'email_verification', 'password_recovery')",
            name="ck_auth_one_time_purpose",
        ),
        sa.CheckConstraint("attempts BETWEEN 0 AND 10", name="ck_auth_one_time_attempts"),
        sa.UniqueConstraint("token_hash", name="uq_auth_one_time_token_hash"),
        schema="platform",
    )
    op.create_index(
        "ix_auth_one_time_tokens_open",
        "auth_one_time_tokens",
        ["purpose", "expires_at"],
        schema="platform",
        postgresql_where=sa.text("consumed_at IS NULL"),
    )

    _security_function(
        """
        CREATE OR REPLACE FUNCTION platform.auth_login_record(p_email citext)
        RETURNS TABLE(
          user_id uuid, email citext, status text, is_superuser boolean,
          password_hash text, failed_attempts integer, locked_until timestamptz
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform
        AS $$
          SELECT u.id, u.email, u.status, u.is_superuser, c.password_hash,
                 c.failed_attempts, c.locked_until
          FROM public.users u
          LEFT JOIN platform.auth_credentials c ON c.user_id = u.id
          WHERE u.email = p_email
        $$
        """,
        "platform.auth_login_record(citext)",
    )
    _security_function(
        """
        CREATE OR REPLACE FUNCTION platform.auth_memberships_for_user(p_user_id uuid)
        RETURNS TABLE(tenant_id uuid, tenant_name text, tenant_slug text, role text)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
          SELECT m.tenant_id, t.name::text, t.slug::text,
                 CASE WHEN m.role = 'editor' THEN 'admin' ELSE m.role END
          FROM public.memberships m
          JOIN public.tenants t ON t.id = m.tenant_id
          WHERE m.user_id = p_user_id AND t.status = 'active'
          ORDER BY t.name, t.id
        $$
        """,
        "platform.auth_memberships_for_user(uuid)",
    )
    _security_function(
        """
        CREATE OR REPLACE FUNCTION platform.auth_record_login_failure(p_user_id uuid)
        RETURNS void
        LANGUAGE sql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, platform
        AS $$
          UPDATE platform.auth_credentials
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE
                WHEN failed_attempts + 1 >= 5 THEN CURRENT_TIMESTAMP + interval '15 minutes'
                ELSE locked_until
              END,
              updated_at = CURRENT_TIMESTAMP
          WHERE user_id = p_user_id
        $$
        """,
        "platform.auth_record_login_failure(uuid)",
    )
    _security_function(
        """
        CREATE OR REPLACE FUNCTION platform.auth_record_login_success(p_user_id uuid)
        RETURNS void
        LANGUAGE sql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, platform
        AS $$
          UPDATE platform.auth_credentials
          SET failed_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = p_user_id
        $$
        """,
        "platform.auth_record_login_success(uuid)",
    )
    _security_function(
        """
        CREATE OR REPLACE FUNCTION platform.auth_create_session(
          p_user_id uuid, p_tenant_id uuid, p_token_hash bytea, p_csrf_hash bytea,
          p_idle_seconds integer, p_idle_expires_at timestamptz,
          p_absolute_expires_at timestamptz, p_user_agent_hash bytea,
          p_ip_hash bytea, p_request_id text
        ) RETURNS uuid
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform, audit
        AS $$
        DECLARE v_session_id uuid;
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM public.users u
            JOIN public.memberships m ON m.user_id = u.id
            JOIN public.tenants t ON t.id = m.tenant_id
            WHERE u.id = p_user_id AND u.status = 'active'
              AND m.tenant_id = p_tenant_id AND t.status = 'active'
          ) THEN
            RAISE EXCEPTION 'invalid active user membership' USING ERRCODE = '42501';
          END IF;
          INSERT INTO platform.auth_sessions(
            user_id, active_tenant_id, token_hash, csrf_token_hash,
            idle_timeout_seconds, idle_expires_at, absolute_expires_at,
            user_agent_hash, ip_hash
          ) VALUES (
            p_user_id, p_tenant_id, p_token_hash, p_csrf_hash,
            p_idle_seconds, p_idle_expires_at, p_absolute_expires_at,
            p_user_agent_hash, p_ip_hash
          ) RETURNING id INTO v_session_id;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
          ) VALUES (
            p_tenant_id, p_user_id, 'auth.login.succeeded', 'auth_session',
            v_session_id, p_request_id, '{}'::jsonb
          );
          RETURN v_session_id;
        END
        $$
        """,
        "platform.auth_create_session(uuid,uuid,bytea,bytea,integer,timestamptz,timestamptz,bytea,bytea,text)",
    )
    _security_function(
        """
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
              idle_expires_at = LEAST(
                s.absolute_expires_at,
                CURRENT_TIMESTAMP + make_interval(secs => s.idle_timeout_seconds)
              )
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
                    CASE WHEN m.role = 'editor' THEN 'admin' ELSE m.role END,
                    s.csrf_token_hash, s.absolute_expires_at, s.rotation_count;
        END
        $$
        """,
        "platform.auth_resolve_session(bytea)",
    )
    _security_function(
        """
        CREATE OR REPLACE FUNCTION platform.auth_switch_session_tenant(
          p_current_hash bytea, p_new_tenant_id uuid, p_new_hash bytea,
          p_new_csrf_hash bytea, p_request_id text
        ) RETURNS boolean
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform, audit
        AS $$
        DECLARE v_session_id uuid; v_user_id uuid; v_old_tenant uuid;
        BEGIN
          SELECT s.id, s.user_id, s.active_tenant_id
          INTO v_session_id, v_user_id, v_old_tenant
          FROM platform.auth_sessions s
          WHERE s.token_hash = p_current_hash AND s.revoked_at IS NULL
            AND s.idle_expires_at > CURRENT_TIMESTAMP
            AND s.absolute_expires_at > CURRENT_TIMESTAMP
          FOR UPDATE;
          IF v_session_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.users u
            JOIN public.memberships m ON m.user_id = u.id
            JOIN public.tenants t ON t.id = m.tenant_id
            WHERE u.id = v_user_id AND u.status = 'active'
              AND m.tenant_id = p_new_tenant_id AND t.status = 'active'
          ) THEN
            RETURN false;
          END IF;
          UPDATE platform.auth_sessions
          SET active_tenant_id = p_new_tenant_id,
              token_hash = p_new_hash,
              csrf_token_hash = p_new_csrf_hash,
              rotation_count = rotation_count + 1,
              last_seen_at = CURRENT_TIMESTAMP,
              idle_expires_at = LEAST(
                absolute_expires_at,
                CURRENT_TIMESTAMP + make_interval(secs => idle_timeout_seconds)
              )
          WHERE id = v_session_id;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
          ) VALUES (
            p_new_tenant_id, v_user_id, 'auth.tenant.switched', 'auth_session',
            v_session_id, p_request_id,
            jsonb_build_object('previous_tenant_id', v_old_tenant)
          );
          RETURN true;
        END
        $$
        """,
        "platform.auth_switch_session_tenant(bytea,uuid,bytea,bytea,text)",
    )
    _security_function(
        """
        CREATE OR REPLACE FUNCTION platform.auth_revoke_session(
          p_token_hash bytea, p_reason text, p_request_id text
        ) RETURNS boolean
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, platform, audit
        AS $$
        DECLARE v_session_id uuid; v_user_id uuid; v_tenant_id uuid;
        BEGIN
          UPDATE platform.auth_sessions
          SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = left(p_reason, 120)
          WHERE token_hash = p_token_hash AND revoked_at IS NULL
          RETURNING id, user_id, active_tenant_id
          INTO v_session_id, v_user_id, v_tenant_id;
          IF v_session_id IS NULL THEN RETURN false; END IF;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id, request_id, metadata
          ) VALUES (
            v_tenant_id, v_user_id, 'auth.session.revoked', 'auth_session',
            v_session_id, p_request_id, jsonb_build_object('reason', left(p_reason, 120))
          );
          RETURN true;
        END
        $$
        """,
        "platform.auth_revoke_session(bytea,text,text)",
    )

    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION platform.protect_last_tenant_owner()
            RETURNS trigger
            LANGUAGE plpgsql SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $$
            DECLARE v_owner_count integer;
            BEGIN
              IF OLD.role <> 'owner'
                 OR (TG_OP = 'UPDATE' AND NEW.role = 'owner') THEN
                RETURN COALESCE(NEW, OLD);
              END IF;
              PERFORM 1 FROM public.memberships
              WHERE tenant_id = OLD.tenant_id AND role = 'owner'
              ORDER BY user_id FOR UPDATE;
              SELECT count(*) INTO v_owner_count FROM public.memberships
              WHERE tenant_id = OLD.tenant_id AND role = 'owner';
              IF v_owner_count <= 1 THEN
                RAISE EXCEPTION 'tenant must retain an owner' USING ERRCODE = '23514';
              END IF;
              RETURN COALESCE(NEW, OLD);
            END
            $$
            """
        )
    )
    op.execute("REVOKE ALL ON FUNCTION platform.protect_last_tenant_owner() FROM PUBLIC")
    op.execute(
        "CREATE TRIGGER trg_memberships_last_owner "
        "BEFORE UPDATE OF role OR DELETE ON memberships "
        "FOR EACH ROW EXECUTE FUNCTION platform.protect_last_tenant_owner()"
    )

    for table in ("auth_credentials", "auth_sessions", "auth_one_time_tokens"):
        op.execute(sa.text(f"REVOKE ALL ON TABLE platform.{table} FROM PUBLIC"))
        op.execute(sa.text(f"REVOKE ALL ON TABLE platform.{table} FROM platform_web"))


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_memberships_last_owner ON memberships")
    op.execute("DROP FUNCTION IF EXISTS platform.protect_last_tenant_owner()")
    for signature in (
        "platform.auth_revoke_session(bytea,text,text)",
        "platform.auth_switch_session_tenant(bytea,uuid,bytea,bytea,text)",
        "platform.auth_resolve_session(bytea)",
        "platform.auth_create_session(uuid,uuid,bytea,bytea,integer,timestamptz,timestamptz,bytea,bytea,text)",
        "platform.auth_record_login_success(uuid)",
        "platform.auth_record_login_failure(uuid)",
        "platform.auth_memberships_for_user(uuid)",
        "platform.auth_login_record(citext)",
    ):
        op.execute(sa.text(f"DROP FUNCTION IF EXISTS {signature}"))
    op.drop_table("auth_one_time_tokens", schema="platform")
    op.drop_table("auth_sessions", schema="platform")
    op.drop_table("auth_credentials", schema="platform")
