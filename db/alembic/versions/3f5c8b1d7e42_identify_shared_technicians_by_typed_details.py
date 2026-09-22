"""identify a shared technician session by typed details

Revision ID: 3f5c8b1d7e42
Revises: 7b3d9e5a1c48
Create Date: 2026-09-22 22:40:00.000000

A shared technician device shows one generic identification form: the
technician types their own name and employee identifier instead of picking a
manager-maintained profile from a list. The identifier is the durable key. An
existing active profile with that identifier is reused (its recorded name must
match), and otherwise a self-declared profile is created for the tenant, so a
tenant can run shared field work without pre-creating every technician.
"""

# ruff: noqa: E501 -- SQL bodies are migration-owned constants.

from collections.abc import Sequence

from alembic import op

revision: str = "3f5c8b1d7e42"
down_revision: str | None = "7b3d9e5a1c48"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TYPED_BINDING = """
        CREATE FUNCTION service.bind_current_technician_session(
          p_full_name text, p_employee_identifier text, p_phone text,
          p_request_id text
        ) RETURNS jsonb
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_user uuid := platform.current_user_id();
          v_session uuid;
          v_absolute_expires_at timestamptz;
          v_name text := btrim(coalesce(p_full_name, ''));
          v_identifier text := btrim(coalesce(p_employee_identifier, ''));
          v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
          v_technician service.technicians%ROWTYPE;
          v_existing service.technician_session_bindings%ROWTYPE;
          v_created boolean := false;
        BEGIN
          IF NOT service.field_service_enabled()
             OR NOT platform.current_tenant_feature_enabled('technicians')
             OR NOT platform.current_tenant_active()
          THEN
            RAISE EXCEPTION 'field service is unavailable' USING ERRCODE = '42501';
          END IF;
          IF coalesce(current_setting('app.current_role', true), '') <> 'technician' THEN
            RAISE EXCEPTION 'only a technician session can identify a technician'
              USING ERRCODE = '42501';
          END IF;
          SELECT context.session_id, context.absolute_expires_at
          INTO v_session, v_absolute_expires_at
          FROM service.lock_current_technician_session_context() context;
          IF v_session IS NULL THEN
            RAISE EXCEPTION 'active authenticated session required' USING ERRCODE = '42501';
          END IF;
          IF service.current_technician_session_mode() <> 'shared' THEN
            RAISE EXCEPTION 'this account does not use shared technician login'
              USING ERRCODE = '42501';
          END IF;
          IF length(v_name) NOT BETWEEN 2 AND 160 THEN
            RAISE EXCEPTION 'enter your full name' USING ERRCODE = '22023';
          END IF;
          IF length(v_identifier) NOT BETWEEN 2 AND 100
             OR v_identifier !~ '^[A-Za-z0-9][A-Za-z0-9 ._/-]*$'
          THEN
            RAISE EXCEPTION 'enter your employee identifier' USING ERRCODE = '22023';
          END IF;
          IF v_phone IS NOT NULL AND length(v_phone) > 40 THEN
            RAISE EXCEPTION 'enter a shorter contact number' USING ERRCODE = '22023';
          END IF;

          -- The employee identifier is the durable key for one physical
          -- technician. A profile that a manager deactivated or bound to an
          -- individual account can never be taken over by typing its details.
          SELECT * INTO v_technician
          FROM service.technicians technician
          WHERE technician.tenant_id = v_tenant
            AND lower(technician.employee_identifier) = lower(v_identifier)
          ORDER BY technician.active DESC, technician.created_at DESC
          LIMIT 1
          FOR SHARE;
          IF FOUND THEN
            IF NOT v_technician.active THEN
              RAISE EXCEPTION 'this employee identifier is not active'
                USING ERRCODE = 'FS403';
            END IF;
            IF v_technician.linked_user_id IS NOT NULL THEN
              RAISE EXCEPTION 'this technician signs in with their own account'
                USING ERRCODE = 'FS403';
            END IF;
            IF lower(btrim(v_technician.full_name)) <> lower(v_name) THEN
              RAISE EXCEPTION 'this employee identifier belongs to another technician'
                USING ERRCODE = 'FS401';
            END IF;
          ELSE
            BEGIN
              INSERT INTO service.technicians(
                tenant_id, full_name, employee_identifier, phone,
                identity_verification, created_by_user_id
              ) VALUES (
                v_tenant, v_name, v_identifier, v_phone, 'self_declared', v_user
              ) RETURNING * INTO v_technician;
              v_created := true;
            EXCEPTION WHEN unique_violation THEN
              -- Another device registered the same identifier first.
              SELECT * INTO v_technician
              FROM service.technicians technician
              WHERE technician.tenant_id = v_tenant
                AND lower(technician.employee_identifier) = lower(v_identifier)
                AND technician.active
              FOR SHARE;
              IF NOT FOUND
                 OR v_technician.linked_user_id IS NOT NULL
                 OR lower(btrim(v_technician.full_name)) <> lower(v_name)
              THEN
                RAISE EXCEPTION 'this employee identifier belongs to another technician'
                  USING ERRCODE = 'FS401';
              END IF;
            END;
            IF v_created THEN
              INSERT INTO audit.records(
                tenant_id, actor_user_id, action, target_type, target_id,
                request_id, metadata
              ) VALUES (
                v_tenant, v_user, 'field_service.technician.created', 'technician',
                v_technician.id, p_request_id,
                jsonb_build_object(
                  'origin', 'shared_session_identification',
                  'authSessionId', v_session, 'verified', false
                )
              );
            END IF;
          END IF;

          SELECT * INTO v_existing
          FROM service.technician_session_bindings binding
          WHERE binding.auth_session_id = v_session
          FOR UPDATE;
          IF FOUND AND v_existing.tenant_id = v_tenant
             AND v_existing.expires_at > CURRENT_TIMESTAMP
          THEN
            -- Re-entering the same details on an identified device is a no-op.
            IF v_existing.technician_id <> v_technician.id THEN
              RAISE EXCEPTION 'this session is already identified as another technician'
                USING ERRCODE = 'FS409';
            END IF;
          ELSE
            INSERT INTO service.technician_session_bindings(
              auth_session_id, tenant_id, user_id, technician_id,
              confirmation_method, bound_at, expires_at
            ) VALUES (
              v_session, v_tenant, v_user, v_technician.id,
              'employee_identifier', CURRENT_TIMESTAMP, v_absolute_expires_at
            )
            ON CONFLICT (auth_session_id) DO UPDATE SET
              tenant_id = EXCLUDED.tenant_id,
              user_id = EXCLUDED.user_id,
              technician_id = EXCLUDED.technician_id,
              confirmation_method = EXCLUDED.confirmation_method,
              bound_at = EXCLUDED.bound_at,
              expires_at = EXCLUDED.expires_at;
            INSERT INTO audit.records(
              tenant_id, actor_user_id, action, target_type, target_id,
              request_id, metadata
            ) VALUES (
              v_tenant, v_user, 'field_service.technician_session.bound',
              'technician', v_technician.id, p_request_id,
              jsonb_build_object(
                'authSessionId', v_session, 'confirmation', 'employee_identifier',
                'profileCreated', v_created
              )
            );
          END IF;
          -- The identifier the technician typed is never echoed back.
          RETURN jsonb_build_object(
            'technicianId', v_technician.id,
            'fullName', v_technician.full_name,
            'identityVerification', v_technician.identity_verification,
            'profileCreated', v_created
          );
        END
        $$
"""


def upgrade() -> None:
    # A shared device identifies by typed details, so the browser no longer
    # picks a technician identifier and no list of profiles is exposed to it.
    op.execute("DROP FUNCTION service.list_session_technician_candidates()")
    op.execute("DROP FUNCTION service.bind_current_technician_session(uuid,text,text)")
    op.execute(TYPED_BINDING)
    op.execute(
        "REVOKE ALL ON FUNCTION "
        "service.bind_current_technician_session(text,text,text,text) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "service.bind_current_technician_session(text,text,text,text) TO platform_web"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION service.bind_current_technician_session(text,text,text,text)")
    op.execute("""
        CREATE FUNCTION service.list_session_technician_candidates()
        RETURNS TABLE(
          technician_id uuid, full_name text, identity_verification text,
          requires_employee_identifier boolean
        )
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        BEGIN
          IF NOT service.field_service_enabled()
             OR NOT platform.current_tenant_feature_enabled('technicians')
             OR service.current_technician_session_mode() <> 'shared'
          THEN
            RETURN;
          END IF;
          RETURN QUERY
            SELECT technician.id, technician.full_name,
                   technician.identity_verification,
                   technician.employee_identifier IS NOT NULL
            FROM service.technicians technician
            WHERE technician.tenant_id = platform.current_tenant_id()
              AND technician.active
              AND technician.linked_user_id IS NULL
            ORDER BY lower(technician.full_name), technician.id
            LIMIT 500;
        END
        $$
    """)
    op.execute("""
        CREATE FUNCTION service.bind_current_technician_session(
          p_technician uuid, p_employee_identifier text, p_request_id text
        ) RETURNS jsonb
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_user uuid := platform.current_user_id();
          v_session uuid;
          v_absolute_expires_at timestamptz;
          v_technician service.technicians%ROWTYPE;
          v_existing service.technician_session_bindings%ROWTYPE;
          v_confirmation text;
        BEGIN
          IF NOT service.field_service_enabled()
             OR NOT platform.current_tenant_feature_enabled('technicians')
             OR NOT platform.current_tenant_active()
          THEN
            RAISE EXCEPTION 'field service is unavailable' USING ERRCODE = '42501';
          END IF;
          IF coalesce(current_setting('app.current_role', true), '') <> 'technician' THEN
            RAISE EXCEPTION 'only a technician session can identify a technician'
              USING ERRCODE = '42501';
          END IF;
          SELECT context.session_id, context.absolute_expires_at
          INTO v_session, v_absolute_expires_at
          FROM service.lock_current_technician_session_context() context;
          IF v_session IS NULL THEN
            RAISE EXCEPTION 'active authenticated session required' USING ERRCODE = '42501';
          END IF;
          IF service.current_technician_session_mode() <> 'shared' THEN
            RAISE EXCEPTION 'this account does not use shared technician login'
              USING ERRCODE = '42501';
          END IF;
          SELECT * INTO v_technician
          FROM service.technicians technician
          WHERE technician.tenant_id = v_tenant
            AND technician.id = p_technician
            AND technician.active
            AND technician.linked_user_id IS NULL
          FOR SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'technician profile not found' USING ERRCODE = 'P0002';
          END IF;
          IF v_technician.employee_identifier IS NOT NULL THEN
            IF lower(btrim(coalesce(p_employee_identifier, '')))
               <> lower(btrim(v_technician.employee_identifier))
            THEN
              RAISE EXCEPTION 'employee identifier does not match the technician profile'
                USING ERRCODE = 'FS401';
            END IF;
            v_confirmation := 'employee_identifier';
          ELSE
            v_confirmation := 'profile_selection';
          END IF;
          SELECT * INTO v_existing
          FROM service.technician_session_bindings binding
          WHERE binding.auth_session_id = v_session
          FOR UPDATE;
          IF FOUND AND v_existing.tenant_id = v_tenant
             AND v_existing.expires_at > CURRENT_TIMESTAMP
          THEN
            IF v_existing.technician_id <> p_technician THEN
              RAISE EXCEPTION 'this session is already identified as another technician'
                USING ERRCODE = 'FS409';
            END IF;
          ELSE
            INSERT INTO service.technician_session_bindings(
              auth_session_id, tenant_id, user_id, technician_id,
              confirmation_method, bound_at, expires_at
            ) VALUES (
              v_session, v_tenant, v_user, p_technician, v_confirmation,
              CURRENT_TIMESTAMP, v_absolute_expires_at
            )
            ON CONFLICT (auth_session_id) DO UPDATE SET
              tenant_id = EXCLUDED.tenant_id,
              user_id = EXCLUDED.user_id,
              technician_id = EXCLUDED.technician_id,
              confirmation_method = EXCLUDED.confirmation_method,
              bound_at = EXCLUDED.bound_at,
              expires_at = EXCLUDED.expires_at;
            INSERT INTO audit.records(
              tenant_id, actor_user_id, action, target_type, target_id,
              request_id, metadata
            ) VALUES (
              v_tenant, v_user, 'field_service.technician_session.bound',
              'technician', p_technician, p_request_id,
              jsonb_build_object(
                'authSessionId', v_session, 'confirmation', v_confirmation
              )
            );
          END IF;
          RETURN jsonb_build_object(
            'technicianId', v_technician.id,
            'fullName', v_technician.full_name,
            'identityVerification', v_technician.identity_verification,
            'confirmation', coalesce(
              CASE WHEN v_existing.tenant_id = v_tenant
                THEN v_existing.confirmation_method END,
              v_confirmation
            ),
            'expiresAt', v_absolute_expires_at
          );
        END
        $$
    """)
    op.execute(
        "REVOKE ALL ON FUNCTION service.list_session_technician_candidates(), "
        "service.bind_current_technician_session(uuid,text,text) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION service.list_session_technician_candidates(), "
        "service.bind_current_technician_session(uuid,text,text) TO platform_web"
    )
