"""scope field-service work to the physical technician of each session

Revision ID: 7b3d9e5a1c48
Revises: f3a8c61e4b27
Create Date: 2026-09-22 10:00:00.000000

One technician platform account may be shared by many physical technicians,
each on their own browser or device. The platform user therefore cannot
identify who performs field work. Every authenticated session names its
physical technician once (``service.technician_session_bindings``); cases,
visits, reports, the dispatch queue, self-claim and technician-created cases
then resolve the technician from the exact ``app.current_session`` of the
transaction. Individually linked technician accounts keep resolving through
``service.technicians.linked_user_id``.
"""

# ruff: noqa: E501 -- SQL bodies are migration-owned constants.

from collections.abc import Sequence

from alembic import op

revision: str = "7b3d9e5a1c48"
down_revision: str | None = "f3a8c61e4b27"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RUNTIME_POLICY_ROLES = (
    "platform_web, platform_worker, platform_messaging, platform_voice, platform_readonly"
)

POLICY_FUNCTIONS = (
    "service.current_actor_can_work_visit(uuid)",
    "service.current_actor_can_work_report(uuid)",
    "service.current_actor_can_work_report_revision(uuid)",
)

WEB_FUNCTIONS = (
    "service.current_session_technician_id()",
    "service.current_technician_session_mode()",
    "service.list_session_technician_candidates()",
    "service.bind_current_technician_session(uuid,text,text)",
    "service.release_current_technician_session(text)",
    "service.create_technician_case(uuid,uuid,text,text,text,text,text,text,text,text)",
)

INTERNAL_FUNCTIONS = (
    "service.lock_current_session_technician()",
    "service.apply_case_assignment(uuid,uuid,boolean,text,text)",
)

WORK_POLICIES = (
    ("visits", "visits_technician_work_insert"),
    ("visits", "visits_technician_work_update"),
    ("visits", "visits_technician_work_delete"),
    ("reports", "reports_technician_work_insert"),
    ("reports", "reports_technician_work_update"),
    ("reports", "reports_technician_work_delete"),
    ("report_revisions", "report_revisions_technician_work_insert"),
    ("report_revisions", "report_revisions_technician_work_update"),
    ("report_revisions", "report_revisions_technician_work_delete"),
    ("report_attachments", "report_attachments_technician_work_insert"),
    ("report_attachments", "report_attachments_technician_work_update"),
    ("report_attachments", "report_attachments_technician_work_delete"),
    ("technician_session_identities", "technician_session_identities_visit_insert"),
    ("technician_session_identities", "technician_session_identities_visit_update"),
)


def _work_policy(table: str, name: str, command: str, expression: str) -> None:
    """AND-compose a mutation boundary; reads keep their case-level scope."""
    if command == "INSERT":
        clause = f"WITH CHECK ({expression})"
    elif command == "DELETE":
        clause = f"USING ({expression})"
    else:
        clause = f"USING ({expression}) WITH CHECK ({expression})"
    op.execute(f'CREATE POLICY {name} ON service."{table}" AS RESTRICTIVE FOR {command} {clause}')


def upgrade() -> None:
    op.execute("""
        CREATE TABLE service.technician_session_bindings (
          auth_session_id uuid PRIMARY KEY
            REFERENCES platform.auth_sessions(id) ON DELETE CASCADE,
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
          technician_id uuid NOT NULL,
          confirmation_method text NOT NULL,
          bound_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at timestamptz NOT NULL,
          FOREIGN KEY (tenant_id, technician_id)
            REFERENCES service.technicians(tenant_id, id) ON DELETE CASCADE,
          CONSTRAINT ck_technician_session_binding_confirmation CHECK (
            confirmation_method IN ('employee_identifier','profile_selection')
          ),
          CONSTRAINT ck_technician_session_binding_expiry CHECK (
            expires_at > bound_at
          )
        )
    """)
    op.execute("""
        CREATE INDEX ix_technician_session_bindings_technician
        ON service.technician_session_bindings(tenant_id, technician_id)
    """)
    op.execute("ALTER TABLE service.technician_session_bindings ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE service.technician_session_bindings FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY technician_session_bindings_tenant_isolation
        ON service.technician_session_bindings
        USING (tenant_id = platform.current_tenant_id())
        WITH CHECK (tenant_id = platform.current_tenant_id())
    """)
    # A technician session can read only its own binding. Every write goes
    # through the SECURITY DEFINER functions below; runtime roles get no DML.
    op.execute("""
        CREATE POLICY technician_session_bindings_session_scope
        ON service.technician_session_bindings AS RESTRICTIVE
        USING (
          coalesce(current_setting('app.current_role', true), '') <> 'technician'
          OR (
            auth_session_id::text = current_setting('app.current_session', true)
            AND user_id = platform.current_user_id()
          )
        )
        WITH CHECK (
          coalesce(current_setting('app.current_role', true), '') <> 'technician'
          OR (
            auth_session_id::text = current_setting('app.current_session', true)
            AND user_id = platform.current_user_id()
          )
        )
    """)
    op.execute("REVOKE ALL ON service.technician_session_bindings FROM PUBLIC")
    op.execute(
        "GRANT SELECT ON service.technician_session_bindings TO platform_web, platform_readonly"
    )

    # The one resolver of "which physical technician is acting". It reads only
    # trusted transaction context: tenant, user, role and the exact session id
    # set by the authentication boundary. A browser never supplies any of them.
    op.execute("""
        CREATE FUNCTION service.current_session_technician_id()
        RETURNS uuid
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_user uuid := platform.current_user_id();
          v_session text := current_setting('app.current_session', true);
          v_technician uuid;
        BEGIN
          IF v_tenant IS NULL OR v_user IS NULL THEN
            RETURN NULL;
          END IF;
          -- An individually linked account keeps its own durable profile.
          SELECT technician.id INTO v_technician
          FROM service.technicians technician
          WHERE technician.tenant_id = v_tenant
            AND technician.linked_user_id = v_user
            AND technician.active;
          IF v_technician IS NOT NULL
             OR coalesce(current_setting('app.current_role', true), '') <> 'technician'
             OR v_session IS NULL
             OR v_session !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN
            RETURN v_technician;
          END IF;
          -- A shared technician account resolves the technician chosen by this
          -- exact, still-valid browser session. Sibling sessions of the same
          -- user carry their own bindings and never influence this one.
          SELECT binding.technician_id INTO v_technician
          FROM service.technician_session_bindings binding
          JOIN platform.auth_sessions auth_session
            ON auth_session.id = binding.auth_session_id
          JOIN public.users account ON account.id = binding.user_id
          JOIN public.memberships membership
            ON membership.tenant_id = binding.tenant_id
           AND membership.user_id = binding.user_id
          JOIN service.technicians technician
            ON technician.tenant_id = binding.tenant_id
           AND technician.id = binding.technician_id
          JOIN service.tenant_configuration configuration
            ON configuration.tenant_id = binding.tenant_id
          WHERE binding.auth_session_id = v_session::uuid
            AND binding.tenant_id = v_tenant
            AND binding.user_id = v_user
            AND binding.expires_at > CURRENT_TIMESTAMP
            AND auth_session.user_id = v_user
            AND auth_session.active_tenant_id = v_tenant
            AND auth_session.revoked_at IS NULL
            AND auth_session.idle_expires_at > CURRENT_TIMESTAMP
            AND auth_session.absolute_expires_at > CURRENT_TIMESTAMP
            AND account.status = 'active'
            AND membership.role = 'technician'
            AND technician.active
            AND technician.linked_user_id IS NULL
            AND configuration.enabled
            AND configuration.shared_technician_login_enabled;
          RETURN v_technician;
        END
        $$
    """)
    op.execute("""
        CREATE FUNCTION service.current_technician_session_mode()
        RETURNS text
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        BEGIN
          IF coalesce(current_setting('app.current_role', true), '') <> 'technician' THEN
            RETURN 'not_technician';
          END IF;
          IF EXISTS (
            SELECT 1 FROM service.technicians own_profile
            WHERE own_profile.tenant_id = platform.current_tenant_id()
              AND own_profile.linked_user_id = platform.current_user_id()
              AND own_profile.active
          ) THEN
            RETURN 'individual';
          END IF;
          IF EXISTS (
            SELECT 1 FROM service.tenant_configuration configuration
            WHERE configuration.tenant_id = platform.current_tenant_id()
              AND configuration.enabled
              AND configuration.shared_technician_login_enabled
          ) THEN
            RETURN 'shared';
          END IF;
          RETURN 'unlinked';
        END
        $$
    """)
    op.execute("""
        CREATE FUNCTION service.lock_current_session_technician()
        RETURNS uuid
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_session uuid; v_technician uuid;
        BEGIN
          SELECT context.session_id INTO v_session
          FROM service.lock_current_technician_session_context() context;
          IF v_session IS NULL THEN
            RETURN NULL;
          END IF;
          v_technician := service.current_session_technician_id();
          IF v_technician IS NULL THEN
            RETURN NULL;
          END IF;
          PERFORM 1 FROM service.technician_session_bindings binding
          WHERE binding.auth_session_id = v_session
          FOR SHARE;
          PERFORM 1 FROM service.technicians technician
          WHERE technician.tenant_id = platform.current_tenant_id()
            AND technician.id = v_technician
            AND technician.active
          FOR SHARE;
          IF NOT FOUND THEN
            RETURN NULL;
          END IF;
          RETURN v_technician;
        END
        $$
    """)
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
          -- Profiles linked to an individual account sign in with that account.
          -- Employee identifiers are confirmation secrets and are never listed.
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
          -- The employee identifier is the confirmation factor; never echo it.
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
    op.execute("""
        CREATE FUNCTION service.release_current_technician_session(p_request_id text)
        RETURNS boolean
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_session uuid; v_technician uuid;
        BEGIN
          IF coalesce(current_setting('app.current_role', true), '') <> 'technician' THEN
            RAISE EXCEPTION 'only a technician session can release its technician'
              USING ERRCODE = '42501';
          END IF;
          SELECT context.session_id INTO v_session
          FROM service.lock_current_technician_session_context() context;
          IF v_session IS NULL THEN
            RAISE EXCEPTION 'active authenticated session required' USING ERRCODE = '42501';
          END IF;
          DELETE FROM service.technician_session_bindings binding
          WHERE binding.auth_session_id = v_session
            AND binding.tenant_id = platform.current_tenant_id()
          RETURNING binding.technician_id INTO v_technician;
          IF v_technician IS NULL THEN
            RETURN false;
          END IF;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            platform.current_tenant_id(), platform.current_user_id(),
            'field_service.technician_session.released', 'technician',
            v_technician, p_request_id,
            jsonb_build_object('authSessionId', v_session)
          );
          RETURN true;
        END
        $$
    """)

    # Case access for technician sessions follows the durable assignment
    # relationships of the session's physical technician. The former shared
    # login branch granted every shared session all dispatched work.
    op.execute("""
        CREATE OR REPLACE FUNCTION service.current_actor_can_access_case(p_case_id uuid)
        RETURNS boolean
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_technician uuid;
        BEGIN
          IF coalesce(current_setting('app.current_role', true), '') <> 'technician' THEN
            RETURN true;
          END IF;
          v_technician := service.current_session_technician_id();
          IF v_technician IS NULL THEN
            RETURN false;
          END IF;
          RETURN EXISTS (
            SELECT 1 FROM service.cases service_case
            WHERE service_case.tenant_id = platform.current_tenant_id()
              AND service_case.id = p_case_id
              AND service_case.assigned_technician_id = v_technician
          ) OR EXISTS (
            SELECT 1 FROM service.appointments appointment
            WHERE appointment.tenant_id = platform.current_tenant_id()
              AND appointment.technician_id = v_technician
              AND appointment.case_id = p_case_id
              AND appointment.status <> 'cancelled'
          ) OR EXISTS (
            SELECT 1 FROM service.visits visit
            WHERE visit.tenant_id = platform.current_tenant_id()
              AND visit.technician_id = v_technician
              AND visit.case_id = p_case_id
              AND visit.status <> 'cancelled'
          );
        END
        $$
    """)
    op.execute("""
        CREATE OR REPLACE FUNCTION service.current_actor_can_access_technician(
          p_technician_id uuid
        ) RETURNS boolean
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        BEGIN
          IF coalesce(current_setting('app.current_role', true), '') <> 'technician' THEN
            RETURN true;
          END IF;
          RETURN p_technician_id IS NOT NULL
            AND p_technician_id = service.current_session_technician_id();
        END
        $$
    """)
    op.execute("""
        CREATE FUNCTION service.current_actor_can_work_visit(p_visit_id uuid)
        RETURNS boolean
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_technician uuid;
        BEGIN
          IF coalesce(current_setting('app.current_role', true), '') <> 'technician' THEN
            RETURN true;
          END IF;
          v_technician := service.current_session_technician_id();
          RETURN v_technician IS NOT NULL AND EXISTS (
            SELECT 1 FROM service.visits visit
            WHERE visit.tenant_id = platform.current_tenant_id()
              AND visit.id = p_visit_id
              AND visit.technician_id = v_technician
          );
        END
        $$
    """)
    op.execute("""
        CREATE FUNCTION service.current_actor_can_work_report(p_report_id uuid)
        RETURNS boolean
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_technician uuid;
        BEGIN
          IF coalesce(current_setting('app.current_role', true), '') <> 'technician' THEN
            RETURN true;
          END IF;
          v_technician := service.current_session_technician_id();
          RETURN v_technician IS NOT NULL AND EXISTS (
            SELECT 1 FROM service.reports report
            JOIN service.visits visit
              ON visit.tenant_id = report.tenant_id AND visit.id = report.visit_id
            WHERE report.tenant_id = platform.current_tenant_id()
              AND report.id = p_report_id
              AND visit.technician_id = v_technician
          );
        END
        $$
    """)
    op.execute("""
        CREATE FUNCTION service.current_actor_can_work_report_revision(
          p_revision_id uuid
        ) RETURNS boolean
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_technician uuid;
        BEGIN
          IF coalesce(current_setting('app.current_role', true), '') <> 'technician' THEN
            RETURN true;
          END IF;
          v_technician := service.current_session_technician_id();
          RETURN v_technician IS NOT NULL AND EXISTS (
            SELECT 1 FROM service.report_revisions revision
            JOIN service.reports report
              ON report.tenant_id = revision.tenant_id AND report.id = revision.report_id
            JOIN service.visits visit
              ON visit.tenant_id = report.tenant_id AND visit.id = report.visit_id
            WHERE revision.tenant_id = platform.current_tenant_id()
              AND revision.id = p_revision_id
              AND visit.technician_id = v_technician
          );
        END
        $$
    """)

    # Reads stay case-scoped so a repeat visit keeps its history, but every
    # write to a visit, its report, its evidence or its identity requires the
    # visit's own technician. A report belongs to the tenant; the session
    # only decides who may currently work on it.
    visit_work = "service.current_actor_can_access_technician(technician_id)"
    for command in ("INSERT", "UPDATE", "DELETE"):
        _work_policy("visits", f"visits_technician_work_{command.lower()}", command, visit_work)
        _work_policy(
            "reports",
            f"reports_technician_work_{command.lower()}",
            command,
            "service.current_actor_can_work_visit(visit_id)",
        )
        _work_policy(
            "report_revisions",
            f"report_revisions_technician_work_{command.lower()}",
            command,
            "service.current_actor_can_work_report(report_id)",
        )
        _work_policy(
            "report_attachments",
            f"report_attachments_technician_work_{command.lower()}",
            command,
            "(visit_id IS NULL OR service.current_actor_can_work_visit(visit_id)) "
            "AND (report_revision_id IS NULL OR "
            "service.current_actor_can_work_report_revision(report_revision_id))",
        )
    for command in ("INSERT", "UPDATE"):
        _work_policy(
            "technician_session_identities",
            f"technician_session_identities_visit_{command.lower()}",
            command,
            "service.current_actor_can_work_visit(visit_id)",
        )

    _replace_dispatch_functions()
    _create_technician_case_function()

    for signature in (*POLICY_FUNCTIONS, *WEB_FUNCTIONS, *INTERNAL_FUNCTIONS):
        op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION {', '.join(POLICY_FUNCTIONS)} TO {RUNTIME_POLICY_ROLES}")
    op.execute(f"GRANT EXECUTE ON FUNCTION {', '.join(WEB_FUNCTIONS)} TO platform_web")


def _replace_dispatch_functions() -> None:
    # One assignment transaction for queue claims, manager (re)assignment and
    # technician-created cases, so locking, conflict detection, visit numbering
    # and audit history cannot drift between entry points. Only the other
    # SECURITY DEFINER functions of this schema call it; no runtime role may.
    op.execute("""
        CREATE FUNCTION service.apply_case_assignment(
          p_case uuid, p_technician uuid, p_self boolean, p_reason text, p_origin text
        ) RETURNS jsonb
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_prior uuid;
          v_visit uuid;
          v_case service.cases%ROWTYPE;
          v_session text := current_setting('app.current_session', true);
        BEGIN
          SELECT * INTO v_case FROM service.cases
          WHERE tenant_id = v_tenant AND id = p_case
          FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'case not found' USING ERRCODE = 'P0002';
          END IF;
          IF v_case.status IN ('closed','completed','cancelled') THEN
            RAISE EXCEPTION 'case is not assignable' USING ERRCODE = '23514';
          END IF;
          v_prior := v_case.assigned_technician_id;
          IF v_prior IS NOT NULL AND v_prior <> p_technician AND p_self THEN
            RAISE EXCEPTION 'another technician already claimed this incident'
              USING ERRCODE = '40001';
          END IF;
          IF p_self AND EXISTS (
            SELECT 1 FROM service.appointments
            WHERE tenant_id = v_tenant AND case_id = p_case
              AND technician_id <> p_technician AND status <> 'cancelled'
          ) THEN
            RAISE EXCEPTION 'incident is already scheduled' USING ERRCODE = '40001';
          END IF;
          IF EXISTS (
            SELECT 1 FROM service.visits
            WHERE tenant_id = v_tenant AND case_id = p_case
              AND technician_id <> p_technician
              AND status IN ('arrived','departed','reported')
          ) THEN
            RAISE EXCEPTION 'an attended visit cannot be reassigned' USING ERRCODE = '23514';
          END IF;
          IF p_self AND EXISTS (
            SELECT 1 FROM service.visits
            WHERE tenant_id = v_tenant AND case_id = p_case
              AND technician_id <> p_technician AND status <> 'cancelled'
          ) THEN
            RAISE EXCEPTION 'incident already assigned' USING ERRCODE = '40001';
          END IF;
          UPDATE service.visits SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = v_tenant AND case_id = p_case
            AND technician_id <> p_technician AND status = 'assigned';
          UPDATE service.appointments SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = v_tenant AND case_id = p_case
            AND technician_id <> p_technician AND status IN ('suggested','scheduled');
          UPDATE service.cases
          SET assigned_technician_id = p_technician, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = v_tenant AND id = p_case;
          SELECT id INTO v_visit FROM service.visits
          WHERE tenant_id = v_tenant AND case_id = p_case
            AND technician_id = p_technician AND status <> 'cancelled'
          ORDER BY visit_number DESC
          LIMIT 1;
          IF v_visit IS NULL THEN
            INSERT INTO service.visits(tenant_id, case_id, technician_id, visit_number)
            SELECT v_tenant, p_case, p_technician, coalesce(max(visit_number), 0) + 1
            FROM service.visits WHERE tenant_id = v_tenant AND case_id = p_case
            RETURNING id INTO v_visit;
          END IF;
          IF v_prior IS DISTINCT FROM p_technician THEN
            INSERT INTO audit.records(
              tenant_id, actor_user_id, action, target_type, target_id, metadata
            ) VALUES (
              v_tenant, platform.current_user_id(),
              CASE WHEN p_self THEN 'field_service.case.claimed'
                ELSE 'field_service.case.reassigned' END,
              'service_case', p_case,
              jsonb_build_object(
                'previousTechnicianId', v_prior, 'technicianId', p_technician,
                'reason', p_reason, 'visitId', v_visit, 'origin', p_origin
              ) || CASE
                WHEN coalesce(current_setting('app.current_role', true), '') = 'technician'
                  AND v_session ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN jsonb_build_object('authSessionId', v_session)
                ELSE '{}'::jsonb END
            );
          END IF;
          RETURN jsonb_build_object(
            'caseId', p_case, 'technicianId', p_technician, 'visitId', v_visit
          );
        END
        $$
    """)
    op.execute("""
        CREATE OR REPLACE FUNCTION service.assign_case(
          p_case uuid, p_technician uuid, p_reason text
        ) RETURNS jsonb
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_tech uuid;
          v_role text := coalesce(current_setting('app.current_role', true), '');
        BEGIN
          IF NOT service.field_service_enabled()
             OR NOT platform.current_tenant_feature_enabled('technicians')
             OR NOT platform.current_tenant_active()
          THEN
            RAISE EXCEPTION 'dispatch disabled' USING ERRCODE = '42501';
          END IF;
          PERFORM 1 FROM service.lock_current_technician_session_context();
          IF NOT FOUND THEN
            RAISE EXCEPTION 'active authenticated session required' USING ERRCODE = '42501';
          END IF;
          IF p_technician IS NULL THEN
            IF NOT coalesce(
              (service.current_workflow_policy()->>'selfAssignmentEnabled')::boolean, false
            ) THEN
              RAISE EXCEPTION 'self assignment disabled' USING ERRCODE = '42501';
            END IF;
            -- The claimant is the physical technician of this session, never a
            -- browser-supplied identifier and never merely the shared user.
            v_tech := service.lock_current_session_technician();
            IF v_tech IS NULL AND service.current_technician_session_mode() = 'shared' THEN
              RAISE EXCEPTION 'identify the technician using this session'
                USING ERRCODE = 'FS428';
            END IF;
          ELSE
            IF v_role NOT IN ('owner','admin')
               OR char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 1000
            THEN
              RAISE EXCEPTION 'manager and reassignment reason required'
                USING ERRCODE = '42501';
            END IF;
            SELECT id INTO v_tech FROM service.technicians
            WHERE tenant_id = v_tenant AND id = p_technician AND active
            FOR SHARE;
          END IF;
          IF v_tech IS NULL THEN
            RAISE EXCEPTION 'eligible technician not found' USING ERRCODE = '42501';
          END IF;
          RETURN service.apply_case_assignment(
            p_case, v_tech, p_technician IS NULL, p_reason,
            CASE WHEN p_technician IS NULL THEN 'queue_claim' ELSE 'manager_assignment' END
          );
        END
        $$
    """)
    op.execute("""
        CREATE OR REPLACE FUNCTION service.list_assignment_queue(p_view text)
        RETURNS SETOF jsonb
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE
          v_technician uuid;
          v_role text := coalesce(current_setting('app.current_role', true), '');
        BEGIN
          IF NOT service.field_service_enabled()
             OR NOT platform.current_tenant_feature_enabled('technicians')
             OR NOT platform.current_tenant_active()
             OR v_role NOT IN ('owner','admin','agent','technician')
          THEN
            RAISE EXCEPTION 'dispatch access denied' USING ERRCODE = '42501';
          END IF;
          IF p_view NOT IN ('available','mine') THEN
            RAISE EXCEPTION 'invalid queue view' USING ERRCODE = '22023';
          END IF;
          v_technician := service.current_session_technician_id();
          IF v_role = 'technician' AND v_technician IS NULL THEN
            IF service.current_technician_session_mode() = 'shared' THEN
              RAISE EXCEPTION 'identify the technician using this session'
                USING ERRCODE = 'FS428';
            END IF;
            RAISE EXCEPTION 'an individual technician account is required'
              USING ERRCODE = '42501';
          END IF;
          IF p_view = 'available'
             AND NOT coalesce(
               (service.current_workflow_policy()->>'selfAssignmentEnabled')::boolean, false
             )
             AND v_role = 'technician'
          THEN
            RETURN;
          END IF;
          RETURN QUERY
            SELECT jsonb_build_object(
              'id', c.id, 'reference', c.reference, 'title', c.title,
              'faultDescription', left(c.fault_description, 1000),
              'status', c.status, 'priority', c.priority,
              'customerName', contact.name, 'storeName', location.name,
              'chainName', chain.name,
              'assignedTechnicianId', c.assigned_technician_id,
              'assignedTechnicianName', tech.full_name, 'updatedAt', c.updated_at
            )
            FROM service.cases c
            JOIN crm.contacts contact
              ON contact.tenant_id = c.tenant_id AND contact.id = c.customer_contact_id
            LEFT JOIN crm.service_locations location
              ON location.tenant_id = c.tenant_id AND location.id = c.service_location_id
            LEFT JOIN crm.service_chains chain
              ON chain.tenant_id = location.tenant_id AND chain.id = location.chain_id
            LEFT JOIN service.technicians tech
              ON tech.tenant_id = c.tenant_id AND tech.id = c.assigned_technician_id
            WHERE c.tenant_id = platform.current_tenant_id()
              AND c.status NOT IN ('closed','cancelled','completed')
              AND CASE WHEN p_view = 'available' THEN
                c.assigned_technician_id IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM service.visits v
                  WHERE v.tenant_id = c.tenant_id AND v.case_id = c.id
                    AND v.status <> 'cancelled'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM service.appointments a
                  WHERE a.tenant_id = c.tenant_id AND a.case_id = c.id
                    AND a.status <> 'cancelled'
                )
              ELSE
                c.assigned_technician_id = v_technician
                OR EXISTS (
                  SELECT 1 FROM service.visits v
                  WHERE v.tenant_id = c.tenant_id AND v.case_id = c.id
                    AND v.technician_id = v_technician AND v.status <> 'cancelled'
                )
              END
            ORDER BY CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
                     c.created_at, c.id
            LIMIT 100;
        END
        $$
    """)


def _create_technician_case_function() -> None:
    # A technician session creates a manual case and takes its field work in
    # the same transaction. The technician is resolved from the session; the
    # caller cannot name one. Owner/admin/agent case creation, WhatsApp intake
    # and voice intake keep their existing paths unchanged.
    op.execute("""
        CREATE FUNCTION service.create_technician_case(
          p_customer_contact uuid, p_service_location uuid, p_title text,
          p_fault_description text, p_warranty_status text, p_product_type text,
          p_product_model text, p_serial_number text, p_priority text,
          p_request_id text
        ) RETURNS jsonb
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_user uuid := platform.current_user_id();
          v_session uuid;
          v_technician uuid;
          v_case uuid := gen_random_uuid();
          v_reference text;
          v_assignment jsonb;
        BEGIN
          IF NOT service.field_service_enabled()
             OR NOT platform.current_tenant_feature_enabled('technicians')
             OR NOT platform.current_tenant_active()
          THEN
            RAISE EXCEPTION 'field service case creation is unavailable'
              USING ERRCODE = '42501';
          END IF;
          IF coalesce(current_setting('app.current_role', true), '') <> 'technician' THEN
            RAISE EXCEPTION 'technician session required' USING ERRCODE = '42501';
          END IF;
          SELECT context.session_id INTO v_session
          FROM service.lock_current_technician_session_context() context;
          IF v_session IS NULL THEN
            RAISE EXCEPTION 'active authenticated session required' USING ERRCODE = '42501';
          END IF;
          v_technician := service.lock_current_session_technician();
          IF v_technician IS NULL THEN
            IF service.current_technician_session_mode() = 'shared' THEN
              RAISE EXCEPTION 'identify the technician using this session'
                USING ERRCODE = 'FS428';
            END IF;
            RAISE EXCEPTION 'an individual technician account is required'
              USING ERRCODE = '42501';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM crm.contacts contact
            WHERE contact.tenant_id = v_tenant AND contact.id = p_customer_contact
          ) THEN
            RAISE EXCEPTION 'customer not found' USING ERRCODE = 'P0002';
          END IF;
          IF p_service_location IS NOT NULL THEN
            PERFORM 1 FROM crm.service_locations location
            WHERE location.tenant_id = v_tenant AND location.id = p_service_location
              AND (
                location.customer_contact_id = p_customer_contact
                OR location.customer_contact_id IS NULL
                OR location.chain_id IS NOT NULL
              )
              AND location.archived_at IS NULL
            FOR SHARE;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'an active service location belonging to the customer is required'
                USING ERRCODE = '22023';
            END IF;
          END IF;
          v_reference := 'FS-' || to_char(CURRENT_TIMESTAMP, 'YYYY') || '-' ||
            upper(left(replace(v_case::text, '-', ''), 8));
          INSERT INTO service.cases(
            id, tenant_id, reference, customer_contact_id, service_location_id,
            title, fault_description, warranty_status, product_type,
            product_model, serial_number, priority, source, created_by_user_id
          ) VALUES (
            v_case, v_tenant, v_reference, p_customer_contact, p_service_location,
            p_title, p_fault_description, coalesce(p_warranty_status, 'unknown'),
            p_product_type, p_product_model, p_serial_number,
            coalesce(p_priority, 'normal'), 'manual', v_user
          );
          INSERT INTO service.case_status_history(
            tenant_id, case_id, to_status, actor_user_id
          ) VALUES (v_tenant, v_case, 'awaiting_scheduling', v_user);
          v_assignment := service.apply_case_assignment(
            v_case, v_technician, true, NULL, 'technician_case_creation'
          );
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_user, 'field_service.case.created', 'service_case', v_case,
            p_request_id,
            jsonb_build_object(
              'origin', 'technician', 'technicianId', v_technician,
              'visitId', v_assignment->'visitId', 'authSessionId', v_session
            )
          );
          RETURN v_assignment || jsonb_build_object('reference', v_reference);
        END
        $$
    """)


def downgrade() -> None:
    for table, name in WORK_POLICIES:
        op.execute(f'DROP POLICY {name} ON service."{table}"')
    _restore_original_access_functions()
    _restore_original_dispatch_functions()
    op.execute(
        "DROP FUNCTION service.create_technician_case"
        "(uuid,uuid,text,text,text,text,text,text,text,text)"
    )
    op.execute("DROP FUNCTION service.apply_case_assignment(uuid,uuid,boolean,text,text)")
    op.execute("DROP FUNCTION service.release_current_technician_session(text)")
    op.execute("DROP FUNCTION service.bind_current_technician_session(uuid,text,text)")
    op.execute("DROP FUNCTION service.list_session_technician_candidates()")
    op.execute("DROP FUNCTION service.lock_current_session_technician()")
    for signature in POLICY_FUNCTIONS:
        op.execute(f"DROP FUNCTION {signature}")
    op.execute("DROP FUNCTION service.current_technician_session_mode()")
    op.execute("DROP FUNCTION service.current_session_technician_id()")
    op.execute("DROP TABLE service.technician_session_bindings")


def _restore_original_access_functions() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION service.current_actor_can_access_case(p_case_id uuid)
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog AS $$
          SELECT CASE
            WHEN coalesce(current_setting('app.current_role', true), '') <> 'technician'
              THEN true
            WHEN EXISTS (
              SELECT 1
              FROM service.technicians technician
              WHERE technician.tenant_id = platform.current_tenant_id()
                AND technician.linked_user_id = platform.current_user_id()
                AND technician.active
                AND (
                  EXISTS (
                    SELECT 1 FROM service.appointments appointment
                    WHERE appointment.tenant_id = technician.tenant_id
                      AND appointment.technician_id = technician.id
                      AND appointment.case_id = p_case_id
                      AND appointment.status <> 'cancelled'
                  ) OR EXISTS (
                    SELECT 1 FROM service.visits visit
                    WHERE visit.tenant_id = technician.tenant_id
                      AND visit.technician_id = technician.id
                      AND visit.case_id = p_case_id
                      AND visit.status <> 'cancelled'
                  )
                )
            ) THEN true
            WHEN NOT EXISTS (
              SELECT 1 FROM service.technicians own_profile
              WHERE own_profile.tenant_id = platform.current_tenant_id()
                AND own_profile.linked_user_id = platform.current_user_id()
                AND own_profile.active
            ) AND EXISTS (
              SELECT 1 FROM service.tenant_configuration configuration
              WHERE configuration.tenant_id = platform.current_tenant_id()
                AND configuration.enabled
                AND configuration.shared_technician_login_enabled
            ) AND (
              EXISTS (
                SELECT 1 FROM service.appointments appointment
                WHERE appointment.tenant_id = platform.current_tenant_id()
                  AND appointment.case_id = p_case_id
                  AND appointment.status <> 'cancelled'
              ) OR EXISTS (
                SELECT 1 FROM service.visits visit
                WHERE visit.tenant_id = platform.current_tenant_id()
                  AND visit.case_id = p_case_id
                  AND visit.status <> 'cancelled'
              )
            ) THEN true
            ELSE false
          END
        $$
    """)
    op.execute("""
        CREATE OR REPLACE FUNCTION service.current_actor_can_access_technician(
          p_technician_id uuid
        ) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog AS $$
          SELECT CASE
            WHEN coalesce(current_setting('app.current_role', true), '') <> 'technician'
              THEN true
            WHEN EXISTS (
              SELECT 1 FROM service.technicians technician
              WHERE technician.tenant_id = platform.current_tenant_id()
                AND technician.id = p_technician_id
                AND technician.linked_user_id = platform.current_user_id()
                AND technician.active
            ) THEN true
            WHEN NOT EXISTS (
              SELECT 1 FROM service.technicians own_profile
              WHERE own_profile.tenant_id = platform.current_tenant_id()
                AND own_profile.linked_user_id = platform.current_user_id()
                AND own_profile.active
            ) AND EXISTS (
              SELECT 1 FROM service.tenant_configuration configuration
              WHERE configuration.tenant_id = platform.current_tenant_id()
                AND configuration.enabled
                AND configuration.shared_technician_login_enabled
            ) AND EXISTS (
              SELECT 1
              FROM service.technicians technician
              WHERE technician.tenant_id = platform.current_tenant_id()
                AND technician.id = p_technician_id
                AND technician.active
                AND (
                  EXISTS (
                    SELECT 1 FROM service.appointments appointment
                    WHERE appointment.tenant_id = technician.tenant_id
                      AND appointment.technician_id = technician.id
                      AND appointment.status <> 'cancelled'
                  ) OR EXISTS (
                    SELECT 1 FROM service.visits visit
                    WHERE visit.tenant_id = technician.tenant_id
                      AND visit.technician_id = technician.id
                      AND visit.status <> 'cancelled'
                  )
                )
            ) THEN true
            ELSE false
          END
        $$
    """)


def _restore_original_dispatch_functions() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION service.list_assignment_queue(p_view text)
        RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_technician uuid; v_role text := coalesce(current_setting('app.current_role',true),'');
        BEGIN
          IF NOT service.field_service_enabled() OR NOT platform.current_tenant_feature_enabled('technicians')
            OR NOT platform.current_tenant_active() OR v_role NOT IN ('owner','admin','agent','technician') THEN
            RAISE EXCEPTION 'dispatch access denied' USING ERRCODE='42501'; END IF;
          IF p_view NOT IN ('available','mine') THEN RAISE EXCEPTION 'invalid queue view' USING ERRCODE='22023'; END IF;
          SELECT id INTO v_technician FROM service.technicians WHERE tenant_id=platform.current_tenant_id()
            AND active AND linked_user_id=platform.current_user_id();
          IF v_role='technician' AND v_technician IS NULL THEN
            RAISE EXCEPTION 'an individual technician account is required' USING ERRCODE='42501'; END IF;
          IF p_view='available' AND NOT coalesce((service.current_workflow_policy()->>'selfAssignmentEnabled')::boolean,false)
            AND v_role='technician' THEN RETURN; END IF;
          RETURN QUERY SELECT jsonb_build_object('id',c.id,'reference',c.reference,'title',c.title,
            'faultDescription',left(c.fault_description,1000),'status',c.status,'priority',c.priority,
            'customerName',contact.name,'storeName',location.name,'chainName',chain.name,
            'assignedTechnicianId',c.assigned_technician_id,'assignedTechnicianName',tech.full_name,'updatedAt',c.updated_at)
          FROM service.cases c JOIN crm.contacts contact ON contact.tenant_id=c.tenant_id AND contact.id=c.customer_contact_id
          LEFT JOIN crm.service_locations location ON location.tenant_id=c.tenant_id AND location.id=c.service_location_id
          LEFT JOIN crm.service_chains chain ON chain.tenant_id=location.tenant_id AND chain.id=location.chain_id
          LEFT JOIN service.technicians tech ON tech.tenant_id=c.tenant_id AND tech.id=c.assigned_technician_id
          WHERE c.tenant_id=platform.current_tenant_id() AND c.status NOT IN ('closed','cancelled','completed')
            AND CASE WHEN p_view='available' THEN c.assigned_technician_id IS NULL
              AND NOT EXISTS(SELECT 1 FROM service.visits v WHERE v.tenant_id=c.tenant_id AND v.case_id=c.id AND v.status<>'cancelled')
              AND NOT EXISTS(SELECT 1 FROM service.appointments a WHERE a.tenant_id=c.tenant_id AND a.case_id=c.id AND a.status<>'cancelled')
            ELSE c.assigned_technician_id=v_technician OR EXISTS(SELECT 1 FROM service.visits v WHERE v.tenant_id=c.tenant_id AND v.case_id=c.id AND v.technician_id=v_technician AND v.status<>'cancelled') END
          ORDER BY CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,c.created_at,c.id LIMIT 100;
        END $$
    """)
    op.execute("""
        CREATE OR REPLACE FUNCTION service.assign_case(p_case uuid,p_technician uuid,p_reason text)
        RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id(); v_tech uuid; v_prior uuid; v_visit uuid; v_case service.cases%ROWTYPE;
          v_role text := coalesce(current_setting('app.current_role',true),'');
        BEGIN
          IF NOT service.field_service_enabled() OR NOT platform.current_tenant_feature_enabled('technicians') OR NOT platform.current_tenant_active() THEN
            RAISE EXCEPTION 'dispatch disabled' USING ERRCODE='42501'; END IF;
          PERFORM 1 FROM service.lock_current_technician_session_context();
          IF NOT FOUND THEN RAISE EXCEPTION 'active authenticated session required' USING ERRCODE='42501'; END IF;
          IF p_technician IS NULL THEN
            IF NOT coalesce((service.current_workflow_policy()->>'selfAssignmentEnabled')::boolean,false) THEN
              RAISE EXCEPTION 'self assignment disabled' USING ERRCODE='42501'; END IF;
            SELECT id INTO v_tech FROM service.technicians WHERE tenant_id=v_tenant AND linked_user_id=platform.current_user_id() AND active FOR SHARE;
          ELSE
            IF v_role NOT IN ('owner','admin') OR char_length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 1000 THEN
              RAISE EXCEPTION 'manager and reassignment reason required' USING ERRCODE='42501'; END IF;
            SELECT id INTO v_tech FROM service.technicians WHERE tenant_id=v_tenant AND id=p_technician AND active FOR SHARE;
          END IF;
          IF v_tech IS NULL THEN RAISE EXCEPTION 'eligible technician not found' USING ERRCODE='42501'; END IF;
          SELECT * INTO v_case FROM service.cases WHERE tenant_id=v_tenant AND id=p_case FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'case not found' USING ERRCODE='P0002'; END IF;
          IF v_case.status IN ('closed','completed','cancelled') THEN RAISE EXCEPTION 'case is not assignable' USING ERRCODE='23514'; END IF;
          v_prior := v_case.assigned_technician_id;
          IF v_prior IS NOT NULL AND v_prior<>v_tech AND p_technician IS NULL THEN
            RAISE EXCEPTION 'another technician already claimed this incident' USING ERRCODE='40001'; END IF;
          IF p_technician IS NULL AND EXISTS(SELECT 1 FROM service.appointments WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id<>v_tech AND status<>'cancelled') THEN
            RAISE EXCEPTION 'incident is already scheduled' USING ERRCODE='40001'; END IF;
          IF EXISTS(SELECT 1 FROM service.visits WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id<>v_tech AND status IN ('arrived','departed','reported')) THEN
            RAISE EXCEPTION 'an attended visit cannot be reassigned' USING ERRCODE='23514'; END IF;
          IF p_technician IS NULL AND EXISTS(SELECT 1 FROM service.visits WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id<>v_tech AND status<>'cancelled') THEN
            RAISE EXCEPTION 'incident already assigned' USING ERRCODE='40001'; END IF;
          UPDATE service.visits SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id<>v_tech AND status='assigned';
          UPDATE service.appointments SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id<>v_tech AND status IN ('suggested','scheduled');
          UPDATE service.cases SET assigned_technician_id=v_tech,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=v_tenant AND id=p_case;
          SELECT id INTO v_visit FROM service.visits WHERE tenant_id=v_tenant AND case_id=p_case AND technician_id=v_tech AND status<>'cancelled' ORDER BY visit_number DESC LIMIT 1;
          IF v_visit IS NULL THEN
            INSERT INTO service.visits(tenant_id,case_id,technician_id,visit_number)
            SELECT v_tenant,p_case,v_tech,coalesce(max(visit_number),0)+1 FROM service.visits WHERE tenant_id=v_tenant AND case_id=p_case RETURNING id INTO v_visit;
          END IF;
          IF v_prior IS DISTINCT FROM v_tech THEN
            INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
            VALUES(v_tenant,platform.current_user_id(),CASE WHEN p_technician IS NULL THEN 'field_service.case.claimed' ELSE 'field_service.case.reassigned' END,
              'service_case',p_case,jsonb_build_object('previousTechnicianId',v_prior,'technicianId',v_tech,'reason',p_reason,'visitId',v_visit));
          END IF;
          RETURN jsonb_build_object('caseId',p_case,'technicianId',v_tech,'visitId',v_visit);
        END $$
    """)
