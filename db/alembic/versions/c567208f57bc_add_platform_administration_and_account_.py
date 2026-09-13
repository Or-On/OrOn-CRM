"""add platform administration and account management

Revision ID: c567208f57bc
Revises: 50a6befe7903
Create Date: 2026-09-09 14:58:19.662611
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c567208f57bc"
down_revision: str | None = "50a6befe7903"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _secure_function(sql: str, signature: str) -> None:
    op.execute(sa.text(sql))
    op.execute(sa.text(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC"))
    op.execute(sa.text(f"GRANT EXECUTE ON FUNCTION {signature} TO platform_web"))


def _secure_function_for(sql: str, signature: str, roles: Sequence[str]) -> None:
    op.execute(sa.text(sql))
    op.execute(sa.text(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC"))
    role_list = ", ".join(roles)
    op.execute(sa.text(f"GRANT EXECUTE ON FUNCTION {signature} TO {role_list}"))


def upgrade() -> None:
    op.add_column("users", sa.Column("display_name", sa.Text(), nullable=True))
    op.create_index(
        "uq_tenant_invitations_open_email",
        "tenant_invitations",
        ["tenant_id", sa.text("lower(email)")],
        unique=True,
        schema="platform",
        postgresql_where=sa.text("accepted_at IS NULL"),
    )

    # PostgreSQL includes OUT parameters in the return type, so adding profile
    # and platform-administrator fields requires an explicit drop/recreate.
    op.execute("DROP FUNCTION platform.auth_login_record(citext)")
    _secure_function(
        """
        CREATE FUNCTION platform.auth_login_record(p_email citext)
        RETURNS TABLE(
          user_id uuid, email citext, display_name text, status text,
          is_superuser boolean, password_hash text, failed_attempts integer,
          locked_until timestamptz
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform
        AS $$
          SELECT u.id, u.email, u.display_name, u.status, u.is_superuser,
                 c.password_hash, c.failed_attempts, c.locked_until
          FROM public.users u
          LEFT JOIN platform.auth_credentials c ON c.user_id = u.id
          WHERE u.email = p_email
        $$
        """,
        "platform.auth_login_record(citext)",
    )
    _secure_function(
        """
        CREATE OR REPLACE FUNCTION platform.auth_memberships_for_user(p_user_id uuid)
        RETURNS TABLE(tenant_id uuid, tenant_name text, tenant_slug text, role text)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT t.id, t.name::text, t.slug::text,
                 CASE
                   WHEN u.is_superuser THEN 'owner'
                   WHEN m.role = 'editor' THEN 'admin'
                   ELSE m.role
                 END::text
          FROM public.users u
          JOIN public.tenants t ON t.status = 'active'
          LEFT JOIN public.memberships m
            ON m.user_id = u.id AND m.tenant_id = t.id
          WHERE u.id = p_user_id AND u.status = 'active'
            AND (u.is_superuser OR m.user_id IS NOT NULL)
          ORDER BY t.name, t.id
        $$
        """,
        "platform.auth_memberships_for_user(uuid)",
    )

    op.execute("DROP FUNCTION platform.auth_resolve_session(bytea)")
    _secure_function(
        """
        CREATE FUNCTION platform.auth_resolve_session(p_token_hash bytea)
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
                        SELECT CASE WHEN role = 'editor' THEN 'admin' ELSE role END
                        FROM public.memberships membership
                        WHERE membership.user_id = u.id
                          AND membership.tenant_id = t.id
                      )
                    END::text,
                    s.csrf_token_hash, s.absolute_expires_at, s.rotation_count;
        END
        $$
        """,
        "platform.auth_resolve_session(bytea)",
    )
    _secure_function(
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
            JOIN public.tenants t ON t.id = p_tenant_id
            LEFT JOIN public.memberships m
              ON m.user_id = u.id AND m.tenant_id = t.id
            WHERE u.id = p_user_id AND u.status = 'active'
              AND t.status = 'active' AND (u.is_superuser OR m.user_id IS NOT NULL)
          ) THEN
            RAISE EXCEPTION 'invalid active user tenant access' USING ERRCODE = '42501';
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
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            p_tenant_id, p_user_id, 'auth.login.succeeded', 'auth_session',
            v_session_id, p_request_id,
            jsonb_build_object(
              'platform_administrator',
              (SELECT is_superuser FROM public.users WHERE id = p_user_id)
            )
          );
          RETURN v_session_id;
        END
        $$
        """,
        "platform.auth_create_session(uuid,uuid,bytea,bytea,integer,timestamptz,timestamptz,bytea,bytea,text)",
    )
    _secure_function(
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
            JOIN public.tenants t ON t.id = p_new_tenant_id
            LEFT JOIN public.memberships m
              ON m.user_id = u.id AND m.tenant_id = t.id
            WHERE u.id = v_user_id AND u.status = 'active'
              AND t.status = 'active' AND (u.is_superuser OR m.user_id IS NOT NULL)
          ) THEN
            RETURN false;
          END IF;
          UPDATE platform.auth_sessions
          SET active_tenant_id = p_new_tenant_id,
              token_hash = p_new_hash, csrf_token_hash = p_new_csrf_hash,
              rotation_count = rotation_count + 1,
              last_seen_at = CURRENT_TIMESTAMP,
              idle_expires_at = LEAST(
                absolute_expires_at,
                CURRENT_TIMESTAMP + make_interval(secs => idle_timeout_seconds)
              )
          WHERE id = v_session_id;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            p_new_tenant_id, v_user_id, 'auth.tenant.switched', 'auth_session',
            v_session_id, p_request_id,
            jsonb_build_object(
              'previous_tenant_id', v_old_tenant,
              'platform_administrator',
              (SELECT is_superuser FROM public.users WHERE id = v_user_id)
            )
          );
          RETURN true;
        END
        $$
        """,
        "platform.auth_switch_session_tenant(bytea,uuid,bytea,bytea,text)",
    )

    op.execute("DROP FUNCTION platform.current_tenant_team()")
    _secure_function(
        """
        CREATE FUNCTION platform.current_tenant_team()
        RETURNS TABLE(user_id uuid, email text, display_name text, role text)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT member.user_id, account.email::text, account.display_name,
                 CASE WHEN member.role = 'editor' THEN 'admin' ELSE member.role END::text
          FROM public.memberships member
          JOIN public.users account ON account.id = member.user_id
          JOIN public.tenants tenant ON tenant.id = member.tenant_id
          WHERE member.tenant_id = platform.current_tenant_id()
            AND account.status = 'active' AND tenant.status = 'active'
            AND member.role IN ('owner', 'admin', 'editor', 'agent', 'viewer')
            AND EXISTS (
              SELECT 1 FROM public.users actor
              LEFT JOIN public.memberships actor_membership
                ON actor_membership.user_id = actor.id
               AND actor_membership.tenant_id = member.tenant_id
              WHERE actor.id = platform.current_user_id()
                AND actor.status = 'active'
                AND (actor.is_superuser OR actor_membership.user_id IS NOT NULL)
            )
        $$
        """,
        "platform.current_tenant_team()",
    )
    _secure_function_for(
        """
        CREATE OR REPLACE FUNCTION platform.canonical_actor_authorized()
        RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT EXISTS (
            SELECT 1
            FROM public.users actor
            JOIN public.tenants tenant
              ON tenant.id = platform.current_tenant_id()
            LEFT JOIN public.memberships membership
              ON membership.user_id = actor.id
             AND membership.tenant_id = tenant.id
            WHERE actor.id = platform.current_user_id()
              AND actor.status = 'active' AND tenant.status = 'active'
              AND (
                actor.is_superuser OR
                membership.role IN ('owner', 'admin', 'editor')
              )
          )
        $$
        """,
        "platform.canonical_actor_authorized()",
        ("platform_web", "platform_messaging"),
    )
    _secure_function_for(
        """
        CREATE OR REPLACE FUNCTION platform.voice_simulation_eligible(
          p_contact uuid, p_conversation uuid
        ) RETURNS boolean
        LANGUAGE sql SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT EXISTS (
            SELECT 1
            FROM crm.contacts contact
            JOIN messaging.conversations conversation
              ON conversation.contact_id = contact.id
             AND conversation.tenant_id = contact.tenant_id
            JOIN public.tenants tenant ON tenant.id = contact.tenant_id
            WHERE contact.id = p_contact AND conversation.id = p_conversation
              AND contact.tenant_id = platform.current_tenant_id()
              AND tenant.status = 'active'
              AND EXISTS (
                SELECT 1
                FROM public.users actor
                LEFT JOIN public.memberships membership
                  ON membership.user_id = actor.id
                 AND membership.tenant_id = contact.tenant_id
                WHERE actor.id = platform.current_user_id()
                  AND actor.status = 'active'
                  AND (
                    actor.is_superuser OR
                    membership.role IN ('owner', 'admin', 'editor', 'agent')
                  )
              )
              AND contact.voice_consent = 'granted'
              AND contact.lifecycle_status = 'active'
            FOR SHARE OF contact, conversation, tenant
          )
        $$
        """,
        "platform.voice_simulation_eligible(uuid,uuid)",
        ("platform_voice",),
    )

    _secure_function(
        """
        CREATE FUNCTION platform.update_current_tenant_name(
          p_name text, p_request_id text
        ) RETURNS text
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, audit
        AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_actor uuid := platform.current_user_id();
                v_name text := btrim(p_name);
        BEGIN
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
            p_request_id, '{}'::jsonb
          );
          RETURN v_name;
        END
        $$
        """,
        "platform.update_current_tenant_name(text,text)",
    )
    _secure_function(
        """
        CREATE FUNCTION platform.update_current_user_profile(
          p_display_name text, p_email citext, p_request_id text
        ) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, audit
        AS $$
        DECLARE v_user uuid := platform.current_user_id();
                v_tenant uuid := platform.current_tenant_id();
                v_display text := nullif(btrim(p_display_name), '');
        BEGIN
          IF v_user IS NULL OR length(coalesce(v_display, '')) > 120 OR
             p_email IS NULL OR length(p_email::text) > 320 OR
             position('@' IN p_email::text) <= 1 OR
             position('.' IN split_part(p_email::text, '@', 2)) = 0 THEN
            RAISE EXCEPTION 'invalid profile update' USING ERRCODE = '22023';
          END IF;
          UPDATE public.users
          SET display_name = v_display, email = lower(p_email),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = v_user AND status = 'active';
          IF NOT FOUND THEN
            RAISE EXCEPTION 'active account required' USING ERRCODE = '42501';
          END IF;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_user, 'account.profile.updated', 'user', v_user,
            p_request_id, '{}'::jsonb
          );
        END
        $$
        """,
        "platform.update_current_user_profile(text,citext,text)",
    )
    _secure_function(
        r"""
        CREATE FUNCTION platform.change_current_user_password(
          p_password_hash text, p_session_id uuid, p_request_id text
        ) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, platform, audit
        AS $$
        DECLARE v_user uuid := platform.current_user_id();
                v_tenant uuid := platform.current_tenant_id();
        BEGIN
          IF v_user IS NULL OR p_password_hash !~ '^\$argon2id\$' THEN
            RAISE EXCEPTION 'invalid password update' USING ERRCODE = '22023';
          END IF;
          UPDATE platform.auth_credentials
          SET password_hash = p_password_hash, password_changed_at = CURRENT_TIMESTAMP,
              failed_attempts = 0, locked_until = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE user_id = v_user;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'credentials unavailable' USING ERRCODE = '42501';
          END IF;
          UPDATE platform.auth_sessions
          SET revoked_at = CURRENT_TIMESTAMP, revocation_reason = 'password_changed'
          WHERE user_id = v_user AND id <> p_session_id AND revoked_at IS NULL;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_user, 'account.password.changed', 'user', v_user,
            p_request_id, '{}'::jsonb
          );
        END
        $$
        """,
        "platform.change_current_user_password(text,uuid,text)",
    )

    _secure_function(
        """
        CREATE FUNCTION platform.create_current_tenant_invitation(
          p_email citext, p_role text, p_token_hash text,
          p_expires_at timestamptz, p_request_id text
        ) RETURNS uuid
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform, audit
        AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_actor uuid := platform.current_user_id();
                v_id uuid;
        BEGIN
          IF p_role NOT IN ('admin', 'agent', 'viewer') THEN
            RAISE EXCEPTION 'unsupported invitation role' USING ERRCODE = '22023';
          END IF;
          IF p_expires_at <= CURRENT_TIMESTAMP OR
             p_expires_at > CURRENT_TIMESTAMP + interval '8 days' THEN
            RAISE EXCEPTION 'invalid invitation expiry' USING ERRCODE = '22023';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM public.users u
            LEFT JOIN public.memberships m
              ON m.user_id = u.id AND m.tenant_id = v_tenant
            WHERE u.id = v_actor AND u.status = 'active'
              AND (u.is_superuser OR m.role IN ('owner', 'admin', 'editor'))
          ) THEN
            RAISE EXCEPTION 'member management permission required' USING ERRCODE = '42501';
          END IF;
          IF EXISTS (
            SELECT 1 FROM public.users u
            JOIN public.memberships m ON m.user_id = u.id
            WHERE m.tenant_id = v_tenant AND u.email = p_email
          ) THEN
            RAISE EXCEPTION 'user is already a tenant member' USING ERRCODE = '23505';
          END IF;
          DELETE FROM platform.tenant_invitations
          WHERE tenant_id = v_tenant AND lower(email) = lower(p_email::text)
            AND accepted_at IS NULL AND expires_at <= CURRENT_TIMESTAMP;
          INSERT INTO platform.tenant_invitations(
            tenant_id, invited_by_user_id, email, role, token_hash, expires_at
          ) VALUES (
            v_tenant, v_actor, lower(p_email), p_role, p_token_hash, p_expires_at
          ) RETURNING id INTO v_id;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_actor, 'tenant.invitation.created', 'tenant_invitation',
            v_id, p_request_id, jsonb_build_object('role', p_role)
          );
          RETURN v_id;
        END
        $$
        """,
        "platform.create_current_tenant_invitation(citext,text,text,timestamptz,text)",
    )
    _secure_function(
        """
        CREATE FUNCTION platform.auth_invitation_record(p_token_hash text)
        RETURNS TABLE(
          invitation_id uuid, email text, tenant_name text, role text,
          expires_at timestamptz, existing_account boolean
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform
        AS $$
          SELECT invitation.id, invitation.email, tenant.name::text,
                 invitation.role, invitation.expires_at,
                 EXISTS (
                   SELECT 1 FROM public.users account
                   WHERE account.email = invitation.email::citext
                     AND account.status = 'active'
                 )
          FROM platform.tenant_invitations invitation
          JOIN public.tenants tenant ON tenant.id = invitation.tenant_id
          WHERE invitation.token_hash = p_token_hash
            AND invitation.accepted_at IS NULL
            AND invitation.expires_at > CURRENT_TIMESTAMP
            AND tenant.status = 'active'
        $$
        """,
        "platform.auth_invitation_record(text)",
    )
    _secure_function(
        """
        CREATE FUNCTION platform.auth_accept_invitation(
          p_token_hash text, p_password_hash text, p_display_name text,
          p_request_id text
        ) RETURNS boolean
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, platform, audit
        AS $$
        DECLARE v_invitation platform.tenant_invitations%ROWTYPE;
                v_user uuid;
                v_created boolean := false;
                v_display text := nullif(btrim(p_display_name), '');
        BEGIN
          SELECT * INTO v_invitation
          FROM platform.tenant_invitations
          WHERE token_hash = p_token_hash AND accepted_at IS NULL
            AND expires_at > CURRENT_TIMESTAMP
          FOR UPDATE;
          IF v_invitation.id IS NULL THEN
            RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE = '22023';
          END IF;
          SELECT id INTO v_user FROM public.users
          WHERE email = v_invitation.email::citext AND status = 'active';
          IF v_user IS NULL THEN
            IF p_password_hash !~ '^\\$argon2id\\$' THEN
              RAISE EXCEPTION 'a valid password is required' USING ERRCODE = '22023';
            END IF;
            INSERT INTO public.users(id, email, display_name, status)
            VALUES (gen_random_uuid(), lower(v_invitation.email)::citext, v_display, 'active')
            RETURNING id INTO v_user;
            INSERT INTO platform.auth_credentials(user_id, password_hash)
            VALUES (v_user, p_password_hash);
            v_created := true;
          END IF;
          INSERT INTO public.memberships(user_id, tenant_id, role)
          VALUES (v_user, v_invitation.tenant_id, v_invitation.role)
          ON CONFLICT (user_id, tenant_id) DO UPDATE
          SET role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP;
          UPDATE platform.tenant_invitations
          SET accepted_at = CURRENT_TIMESTAMP, accepted_by_user_id = v_user
          WHERE id = v_invitation.id;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_invitation.tenant_id, v_user, 'tenant.invitation.accepted',
            'tenant_invitation', v_invitation.id, p_request_id,
            jsonb_build_object('account_created', v_created, 'role', v_invitation.role)
          );
          RETURN v_created;
        END
        $$
        """,
        "platform.auth_accept_invitation(text,text,text,text)",
    )
    _secure_function(
        """
        CREATE FUNCTION platform.manage_current_tenant_member(
          p_target_user uuid, p_role text, p_remove boolean, p_request_id text
        ) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, public, audit
        AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_actor uuid := platform.current_user_id();
                v_actor_role text;
                v_target_role text;
                v_owner_count integer;
                v_super boolean;
        BEGIN
          SELECT u.is_superuser, m.role INTO v_super, v_actor_role
          FROM public.users u
          LEFT JOIN public.memberships m
            ON m.user_id = u.id AND m.tenant_id = v_tenant
          WHERE u.id = v_actor AND u.status = 'active';
          IF NOT coalesce(v_super, false) AND
             coalesce(v_actor_role, '') NOT IN ('owner', 'admin', 'editor') THEN
            RAISE EXCEPTION 'member management permission required' USING ERRCODE = '42501';
          END IF;
          SELECT role INTO v_target_role FROM public.memberships
          WHERE tenant_id = v_tenant AND user_id = p_target_user;
          IF v_target_role IS NULL THEN
            RAISE EXCEPTION 'tenant member not found' USING ERRCODE = 'P0002';
          END IF;
          IF p_target_user = v_actor AND p_remove THEN
            RAISE EXCEPTION 'cannot remove the active account' USING ERRCODE = '22023';
          END IF;
          IF p_role NOT IN ('owner', 'admin', 'agent', 'viewer') THEN
            RAISE EXCEPTION 'unsupported membership role' USING ERRCODE = '22023';
          END IF;
          IF p_role = 'owner' AND NOT (coalesce(v_super, false) OR v_actor_role = 'owner') THEN
            RAISE EXCEPTION 'only an owner can grant ownership' USING ERRCODE = '42501';
          END IF;
          IF v_target_role = 'owner' AND
             NOT (coalesce(v_super, false) OR v_actor_role = 'owner') THEN
            RAISE EXCEPTION 'only an owner can manage another owner' USING ERRCODE = '42501';
          END IF;
          IF v_target_role = 'owner' AND (p_remove OR p_role <> 'owner') THEN
            SELECT count(*) INTO v_owner_count
            FROM public.memberships
            WHERE tenant_id = v_tenant AND role = 'owner';
            IF v_owner_count <= 1 THEN
              RAISE EXCEPTION 'a tenant must retain at least one owner'
                USING ERRCODE = '22023';
            END IF;
          END IF;
          IF p_remove THEN
            DELETE FROM public.memberships
            WHERE tenant_id = v_tenant AND user_id = p_target_user;
          ELSE
            UPDATE public.memberships SET role = p_role, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = v_tenant AND user_id = p_target_user;
          END IF;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_actor,
            CASE WHEN p_remove THEN 'tenant.member.removed' ELSE 'tenant.member.role.updated' END,
            'user', p_target_user, p_request_id,
            CASE WHEN p_remove THEN '{}'::jsonb ELSE jsonb_build_object('role', p_role) END
          );
        END
        $$
        """,
        "platform.manage_current_tenant_member(uuid,text,boolean,text)",
    )


def downgrade() -> None:
    for signature in (
        "platform.manage_current_tenant_member(uuid,text,boolean,text)",
        "platform.auth_accept_invitation(text,text,text,text)",
        "platform.auth_invitation_record(text)",
        "platform.create_current_tenant_invitation(citext,text,text,timestamptz,text)",
        "platform.change_current_user_password(text,uuid,text)",
        "platform.update_current_user_profile(text,citext,text)",
        "platform.update_current_tenant_name(text,text)",
    ):
        op.execute(sa.text(f"DROP FUNCTION IF EXISTS {signature}"))

    # Restore the exact membership-scoped authentication boundary. A platform
    # administrator session opened on a tenant without membership becomes
    # invalid after this rollback instead of retaining broader access.
    op.execute("DROP FUNCTION platform.current_tenant_team()")
    _secure_function(
        """
        CREATE FUNCTION platform.current_tenant_team()
        RETURNS TABLE(user_id uuid, email text, role text)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT member.user_id, account.email::text,
                 CASE WHEN member.role = 'editor' THEN 'admin' ELSE member.role END::text
          FROM public.memberships member
          JOIN public.users account ON account.id = member.user_id
          JOIN public.tenants tenant ON tenant.id = member.tenant_id
          WHERE member.tenant_id = platform.current_tenant_id()
            AND account.status = 'active' AND tenant.status = 'active'
            AND member.role IN ('owner', 'admin', 'editor', 'agent', 'viewer')
            AND EXISTS (
              SELECT 1 FROM public.memberships actor_membership
              JOIN public.users actor ON actor.id = actor_membership.user_id
              WHERE actor_membership.tenant_id = member.tenant_id
                AND actor_membership.user_id = platform.current_user_id()
                AND actor_membership.role IN ('owner', 'admin', 'editor', 'agent', 'viewer')
                AND actor.status = 'active'
            )
        $$
        """,
        "platform.current_tenant_team()",
    )
    op.execute("DROP FUNCTION platform.auth_resolve_session(bytea)")
    _secure_function(
        """
        CREATE FUNCTION platform.auth_resolve_session(p_token_hash bytea)
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
                    (CASE WHEN m.role = 'editor' THEN 'admin' ELSE m.role END)::text,
                    s.csrf_token_hash, s.absolute_expires_at, s.rotation_count;
        END
        $$
        """,
        "platform.auth_resolve_session(bytea)",
    )
    op.execute("DROP FUNCTION platform.auth_login_record(citext)")
    _secure_function(
        """
        CREATE FUNCTION platform.auth_login_record(p_email citext)
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
    _secure_function(
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
    _secure_function(
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
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
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
    _secure_function(
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
              token_hash = p_new_hash, csrf_token_hash = p_new_csrf_hash,
              rotation_count = rotation_count + 1,
              last_seen_at = CURRENT_TIMESTAMP,
              idle_expires_at = LEAST(
                absolute_expires_at,
                CURRENT_TIMESTAMP + make_interval(secs => idle_timeout_seconds)
              )
          WHERE id = v_session_id;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
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
    _secure_function_for(
        """
        CREATE OR REPLACE FUNCTION platform.canonical_actor_authorized()
        RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT EXISTS (
            SELECT 1
            FROM public.memberships membership
            JOIN public.users actor ON actor.id = membership.user_id
            JOIN public.tenants tenant ON tenant.id = membership.tenant_id
            WHERE membership.tenant_id = platform.current_tenant_id()
              AND membership.user_id = platform.current_user_id()
              AND membership.role IN ('owner', 'admin', 'editor')
              AND actor.status = 'active' AND tenant.status = 'active'
          )
        $$
        """,
        "platform.canonical_actor_authorized()",
        ("platform_web", "platform_messaging"),
    )
    _secure_function_for(
        """
        CREATE OR REPLACE FUNCTION platform.voice_simulation_eligible(
          p_contact uuid, p_conversation uuid
        ) RETURNS boolean
        LANGUAGE sql SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT EXISTS (
            SELECT 1
            FROM crm.contacts contact
            JOIN messaging.conversations conversation
              ON conversation.contact_id = contact.id
             AND conversation.tenant_id = contact.tenant_id
            JOIN public.memberships membership
              ON membership.tenant_id = contact.tenant_id
            JOIN public.users actor ON actor.id = membership.user_id
            JOIN public.tenants tenant ON tenant.id = contact.tenant_id
            WHERE contact.id = p_contact AND conversation.id = p_conversation
              AND contact.tenant_id = platform.current_tenant_id()
              AND membership.user_id = platform.current_user_id()
              AND membership.role IN ('owner', 'admin', 'editor', 'agent')
              AND actor.status = 'active' AND tenant.status = 'active'
              AND contact.voice_consent = 'granted'
              AND contact.lifecycle_status = 'active'
            FOR SHARE OF contact, conversation, membership, actor, tenant
          )
        $$
        """,
        "platform.voice_simulation_eligible(uuid,uuid)",
        ("platform_voice",),
    )
    op.drop_index(
        "uq_tenant_invitations_open_email",
        table_name="tenant_invitations",
        schema="platform",
    )
    op.drop_column("users", "display_name")
