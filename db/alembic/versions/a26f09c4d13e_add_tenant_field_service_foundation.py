"""add tenant field service foundation

Revision ID: a26f09c4d13e
Revises: 91bd6f76a3e4
Create Date: 2026-09-14 20:05:00.000000
"""

# ruff: noqa: S608 -- generated SQL interpolates only closed migration constants.

from collections.abc import Sequence

from alembic import op

revision: str = "a26f09c4d13e"
down_revision: str | None = "91bd6f76a3e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SERVICE_TABLES = (
    "tenant_configuration",
    "feature_change_history",
    "technicians",
    "intake_drafts",
    "intake_messages",
    "cases",
    "case_status_history",
    "appointments",
    "appointment_history",
    "visits",
    "technician_session_identities",
    "reports",
    "report_revisions",
    "report_attachments",
    "ocr_results",
    "case_conversations",
    "case_calls",
    "case_summaries",
    "export_records",
)


def _tenant_policy(schema: str, table: str) -> None:
    qualified = f'"{schema}"."{table}"'
    op.execute(f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {qualified} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY {table}_tenant_isolation ON {qualified} "
        "USING (tenant_id = platform.current_tenant_id()) "
        "WITH CHECK (tenant_id = platform.current_tenant_id())"
    )


def _technician_scope_policy(table: str, expression: str) -> None:
    """Add an AND-composed assignment boundary for the restricted role."""
    op.execute(
        f'CREATE POLICY {table}_technician_scope ON service."{table}" '
        "AS RESTRICTIVE "
        f"USING ({expression}) WITH CHECK ({expression})"
    )


def _feature_mutation_policy(table: str) -> None:
    """Block user-path mutations while the optional capability is inactive.

    Internal service workers remain able to persist a cancellation/failure
    receipt after a tenant disables the feature mid-job; each worker still
    rechecks activation before an external side effect.
    """
    allowed = (
        "(service.field_service_enabled() OR "
        "coalesce(current_setting('app.current_role', true), '') = 'service')"
    )
    op.execute(
        f'CREATE POLICY {table}_feature_insert ON service."{table}" '
        f"AS RESTRICTIVE FOR INSERT WITH CHECK ({allowed})"
    )
    op.execute(
        f'CREATE POLICY {table}_feature_update ON service."{table}" '
        f"AS RESTRICTIVE FOR UPDATE USING ({allowed}) WITH CHECK ({allowed})"
    )
    op.execute(
        f'CREATE POLICY {table}_feature_delete ON service."{table}" '
        f"AS RESTRICTIVE FOR DELETE USING ({allowed})"
    )


def _restore_member_functions(include_technician: bool) -> None:
    all_roles = "'owner','admin','editor','agent','viewer'"
    canonical_roles = "'owner','admin','agent','viewer'"
    invitation_roles = "'admin','agent','viewer'"
    if include_technician:
        all_roles += ",'technician'"
        canonical_roles += ",'technician'"
        invitation_roles += ",'technician'"

    op.execute("DROP FUNCTION IF EXISTS platform.current_tenant_team()")
    op.execute(f"""
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
            AND member.role IN ({all_roles})
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
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.current_tenant_team() FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION platform.current_tenant_team() TO platform_web")

    op.execute(f"""
        CREATE OR REPLACE FUNCTION platform.lock_current_authorization(
          p_session_id uuid, p_expected_role text, p_expected_superuser boolean,
          p_rotation_count integer
        ) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path=pg_catalog AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_user uuid := platform.current_user_id();
                v_superuser boolean; v_role text;
                v_idle timestamptz; v_absolute timestamptz;
        BEGIN
          PERFORM 1 FROM public.tenants
          WHERE id=v_tenant AND status='active' FOR SHARE;
          IF NOT FOUND THEN RETURN false; END IF;
          SELECT is_superuser INTO v_superuser FROM public.users
            WHERE id=v_user AND status='active' FOR SHARE;
          IF NOT FOUND OR v_superuser IS DISTINCT FROM p_expected_superuser THEN
            RETURN false;
          END IF;
          IF v_superuser THEN v_role := 'owner';
          ELSE
            SELECT CASE WHEN role='editor' THEN 'admin' ELSE role END INTO v_role
            FROM public.memberships
            WHERE tenant_id=v_tenant AND user_id=v_user FOR SHARE;
            IF NOT FOUND THEN RETURN false; END IF;
          END IF;
          IF v_role IS DISTINCT FROM p_expected_role OR v_role NOT IN
             ({canonical_roles}) THEN RETURN false; END IF;
          SELECT idle_expires_at,absolute_expires_at INTO v_idle,v_absolute
          FROM platform.auth_sessions
          WHERE id=p_session_id AND user_id=v_user AND active_tenant_id=v_tenant
            AND revoked_at IS NULL AND rotation_count=p_rotation_count
          FOR SHARE;
          RETURN FOUND AND v_idle>clock_timestamp() AND v_absolute>clock_timestamp();
        END $$
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION
          platform.lock_current_authorization(uuid,text,boolean,integer) FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION
          platform.lock_current_authorization(uuid,text,boolean,integer) TO platform_web
    """)

    op.execute(f"""
        CREATE OR REPLACE FUNCTION platform.create_current_tenant_invitation(
          p_email citext, p_role text, p_token_hash text,
          p_expires_at timestamptz, p_request_id text
        ) RETURNS uuid
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_actor uuid := platform.current_user_id();
                v_id uuid;
        BEGIN
          IF p_role NOT IN ({invitation_roles}) THEN
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
            RAISE EXCEPTION 'member management permission required'
              USING ERRCODE = '42501';
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
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION
          platform.create_current_tenant_invitation(citext,text,text,timestamptz,text)
          FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION
          platform.create_current_tenant_invitation(citext,text,text,timestamptz,text)
          TO platform_web
    """)

    op.execute(f"""
        CREATE OR REPLACE FUNCTION platform.manage_current_tenant_member(
          p_target_user uuid, p_role text, p_remove boolean, p_request_id text
        ) RETURNS void
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_actor uuid := platform.current_user_id();
                v_actor_role text; v_target_role text;
                v_owner_count integer; v_super boolean;
        BEGIN
          SELECT u.is_superuser, m.role INTO v_super, v_actor_role
          FROM public.users u
          LEFT JOIN public.memberships m
            ON m.user_id = u.id AND m.tenant_id = v_tenant
          WHERE u.id = v_actor AND u.status = 'active';
          IF NOT coalesce(v_super, false) AND
             coalesce(v_actor_role, '') NOT IN ('owner', 'admin', 'editor') THEN
            RAISE EXCEPTION 'member management permission required'
              USING ERRCODE = '42501';
          END IF;
          SELECT role INTO v_target_role FROM public.memberships
          WHERE tenant_id = v_tenant AND user_id = p_target_user;
          IF v_target_role IS NULL THEN
            RAISE EXCEPTION 'tenant member not found' USING ERRCODE = 'P0002';
          END IF;
          IF p_target_user = v_actor AND p_remove THEN
            RAISE EXCEPTION 'cannot remove the active account' USING ERRCODE = '22023';
          END IF;
          IF p_role NOT IN ({canonical_roles}) THEN
            RAISE EXCEPTION 'unsupported membership role' USING ERRCODE = '22023';
          END IF;
          IF p_role = 'owner' AND NOT (
            coalesce(v_super, false) OR v_actor_role = 'owner'
          ) THEN
            RAISE EXCEPTION 'only an owner can grant ownership' USING ERRCODE = '42501';
          END IF;
          IF v_target_role = 'owner' AND NOT (
            coalesce(v_super, false) OR v_actor_role = 'owner'
          ) THEN
            RAISE EXCEPTION 'only an owner can manage another owner'
              USING ERRCODE = '42501';
          END IF;
          IF v_target_role = 'owner' AND (p_remove OR p_role <> 'owner') THEN
            SELECT count(*) INTO v_owner_count FROM public.memberships
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
            UPDATE public.memberships
            SET role = p_role, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = v_tenant AND user_id = p_target_user;
          END IF;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_actor,
            CASE WHEN p_remove THEN 'tenant.member.removed'
                 ELSE 'tenant.member.role.updated' END,
            'user', p_target_user, p_request_id,
            CASE WHEN p_remove THEN '{{}}'::jsonb
                 ELSE jsonb_build_object('role', p_role) END
          );
        END
        $$
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION
          platform.manage_current_tenant_member(uuid,text,boolean,text) FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION
          platform.manage_current_tenant_member(uuid,text,boolean,text) TO platform_web
    """)


def upgrade() -> None:
    op.execute("CREATE SCHEMA service")
    op.execute("REVOKE ALL ON SCHEMA service FROM PUBLIC")

    op.execute("""
        ALTER TABLE crm.tenant_settings
          ADD COLUMN business_name text,
          ADD COLUMN business_email text,
          ADD COLUMN business_phone text,
          ADD COLUMN business_address text,
          ADD COLUMN accent_token text,
          ADD COLUMN report_header text,
          ADD COLUMN report_footer text,
          ADD CONSTRAINT ck_tenant_accent_token CHECK (
            accent_token IS NULL OR accent_token IN
              ('blue','cyan','emerald','violet','amber','rose')
          )
    """)

    op.execute("""
        CREATE TABLE platform.tenant_feature_entitlements (
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          feature_key text NOT NULL,
          available boolean NOT NULL DEFAULT false,
          granted_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          granted_at timestamptz,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (tenant_id, feature_key),
          CONSTRAINT ck_tenant_feature_key CHECK (feature_key = 'field_service'),
          CONSTRAINT ck_tenant_feature_grant CHECK (
            (available AND granted_at IS NOT NULL) OR NOT available
          )
        )
    """)

    op.execute("""
        CREATE TABLE service.tenant_configuration (
          tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
          enabled boolean NOT NULL DEFAULT false,
          whatsapp_intake_enabled boolean NOT NULL DEFAULT false,
          ai_scheduling_enabled boolean NOT NULL DEFAULT false,
          ocr_enabled boolean NOT NULL DEFAULT false,
          shared_technician_login_enabled boolean NOT NULL DEFAULT false,
          ai_schedule_requires_approval boolean NOT NULL DEFAULT true,
          calendar_access text NOT NULL DEFAULT 'none',
          calendar_provider text,
          changed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT ck_service_calendar_access CHECK (
            calendar_access IN ('none','read_only','write')
          ),
          CONSTRAINT ck_service_calendar_provider CHECK (
            (calendar_access = 'none' AND calendar_provider IS NULL)
            OR (calendar_access <> 'none' AND calendar_provider = 'crm_calendar')
          )
        )
    """)
    op.execute("""
        CREATE TABLE service.feature_change_history (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          available boolean NOT NULL,
          enabled boolean NOT NULL,
          settings jsonb NOT NULL DEFAULT '{}'::jsonb,
          request_id text,
          changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id)
        )
    """)

    op.execute("""
        CREATE TABLE crm.customer_profiles (
          tenant_id uuid NOT NULL,
          contact_id uuid NOT NULL,
          national_id_ciphertext text,
          national_id_blind_index text,
          national_id_hint text,
          preferred_language text,
          address text,
          details jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (tenant_id, contact_id),
          FOREIGN KEY (tenant_id, contact_id)
            REFERENCES crm.contacts(tenant_id, id) ON DELETE CASCADE,
          CONSTRAINT ck_customer_national_id_shape CHECK (
            (national_id_ciphertext IS NULL AND national_id_blind_index IS NULL
              AND national_id_hint IS NULL)
            OR (national_id_ciphertext IS NOT NULL
              AND national_id_blind_index IS NOT NULL
              AND national_id_hint IS NOT NULL
              AND national_id_hint ~ '^[0-9]{0,4}$')
          )
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_customer_national_id
        ON crm.customer_profiles(tenant_id, national_id_blind_index)
        WHERE national_id_blind_index IS NOT NULL
    """)
    op.execute("""
        CREATE TABLE crm.customer_classifications (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          name text NOT NULL,
          description text,
          color text NOT NULL DEFAULT 'slate',
          active boolean NOT NULL DEFAULT true,
          created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          CONSTRAINT ck_customer_classification_name CHECK (
            length(btrim(name)) BETWEEN 1 AND 80
          ),
          CONSTRAINT ck_customer_classification_color CHECK (
            color IN ('slate','blue','cyan','emerald','violet','amber','rose')
          )
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_customer_classification_name
        ON crm.customer_classifications(tenant_id, lower(name))
        WHERE active
    """)
    op.execute("""
        CREATE TABLE crm.contact_classifications (
          tenant_id uuid NOT NULL,
          contact_id uuid NOT NULL,
          classification_id uuid NOT NULL,
          assigned_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          assigned_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (tenant_id, contact_id, classification_id),
          FOREIGN KEY (tenant_id, contact_id)
            REFERENCES crm.contacts(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, classification_id)
            REFERENCES crm.customer_classifications(tenant_id, id) ON DELETE CASCADE
        )
    """)
    op.execute("""
        CREATE TABLE crm.service_locations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          customer_contact_id uuid,
          name text NOT NULL,
          address text,
          latitude numeric(9,6),
          longitude numeric(9,6),
          contact_name text,
          contact_phone text,
          contact_email text,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          FOREIGN KEY (tenant_id, customer_contact_id)
            REFERENCES crm.contacts(tenant_id, id) ON DELETE SET NULL (customer_contact_id),
          CONSTRAINT ck_service_location_name CHECK (
            length(btrim(name)) BETWEEN 1 AND 160
          ),
          CONSTRAINT ck_service_location_coordinates CHECK (
            (latitude IS NULL AND longitude IS NULL) OR
            (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
          )
        )
    """)
    op.execute("""
        CREATE INDEX ix_service_locations_customer
        ON crm.service_locations(tenant_id, customer_contact_id, lower(name))
    """)
    op.execute("""
        CREATE TABLE crm.customer_documents (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          contact_id uuid NOT NULL,
          object_id uuid NOT NULL,
          display_name text NOT NULL,
          category text NOT NULL DEFAULT 'general',
          caption text,
          created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          deleted_at timestamptz,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, object_id),
          FOREIGN KEY (tenant_id, contact_id)
            REFERENCES crm.contacts(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, object_id)
            REFERENCES objects.object_metadata(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_customer_document_name CHECK (
            length(btrim(display_name)) BETWEEN 1 AND 240
          ),
          CONSTRAINT ck_customer_document_category CHECK (
            category IN ('general','warranty','invoice','manual','identity','other')
          ),
          CONSTRAINT ck_customer_document_caption CHECK (
            caption IS NULL OR length(caption) <= 1000
          )
        )
    """)
    op.execute("""
        CREATE INDEX ix_customer_documents_contact
        ON crm.customer_documents(tenant_id, contact_id, created_at DESC, id)
        WHERE deleted_at IS NULL
    """)

    op.execute("""
        CREATE TABLE service.technicians (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          linked_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          employee_identifier text,
          full_name text NOT NULL,
          phone text,
          email text,
          identity_verification text NOT NULL DEFAULT 'self_declared',
          active boolean NOT NULL DEFAULT true,
          created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          CONSTRAINT ck_technician_name CHECK (
            length(btrim(full_name)) BETWEEN 2 AND 160
          ),
          CONSTRAINT ck_technician_verification CHECK (
            identity_verification IN ('self_declared','verified','revoked')
          )
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_technician_employee_identifier
        ON service.technicians(tenant_id, lower(employee_identifier))
        WHERE employee_identifier IS NOT NULL AND active
    """)

    op.execute("""
        CREATE TABLE service.intake_drafts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          conversation_id uuid NOT NULL,
          reporting_contact_id uuid NOT NULL,
          customer_contact_id uuid,
          customer_resolution_status text NOT NULL DEFAULT 'unresolved',
          customer_resolution_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
          correlation_key text NOT NULL,
          status text NOT NULL DEFAULT 'collecting',
          collected_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
          national_id_ciphertext text,
          national_id_blind_index text,
          national_id_hint text,
          required_field_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
          last_message_at timestamptz,
          confirmed_at timestamptz,
          confirmed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, correlation_key),
          FOREIGN KEY (tenant_id, conversation_id)
            REFERENCES messaging.conversations(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, reporting_contact_id)
            REFERENCES crm.contacts(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, customer_contact_id)
            REFERENCES crm.contacts(tenant_id, id) ON DELETE SET NULL (customer_contact_id),
          CONSTRAINT ck_intake_status CHECK (
            status IN ('collecting','awaiting_confirmation','confirmed',
              'handed_off','expired')
          ),
          CONSTRAINT ck_intake_customer_resolution CHECK (
            customer_resolution_status IN
              ('unresolved','reporting_contact','matched','created','conflict','invalid_phone')
          ),
          CONSTRAINT ck_intake_correlation CHECK (
            length(btrim(correlation_key)) BETWEEN 8 AND 200
          ),
          CONSTRAINT ck_intake_national_id_shape CHECK (
            (national_id_ciphertext IS NULL AND national_id_blind_index IS NULL
              AND national_id_hint IS NULL)
            OR (national_id_ciphertext IS NOT NULL
              AND national_id_blind_index IS NOT NULL
              AND national_id_hint IS NOT NULL
              AND national_id_hint ~ '^[0-9]{0,4}$')
          )
        )
    """)
    op.execute("""
        CREATE TABLE service.intake_messages (
          tenant_id uuid NOT NULL,
          intake_draft_id uuid NOT NULL,
          message_id uuid NOT NULL,
          observed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (tenant_id, intake_draft_id, message_id),
          FOREIGN KEY (tenant_id, intake_draft_id)
            REFERENCES service.intake_drafts(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, message_id)
            REFERENCES messaging.messages(tenant_id, id) ON DELETE RESTRICT
        )
    """)

    op.execute("""
        CREATE TABLE service.cases (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          reference text NOT NULL,
          customer_contact_id uuid NOT NULL,
          reporting_contact_id uuid,
          service_location_id uuid,
          intake_draft_id uuid,
          conversation_id uuid,
          status text NOT NULL DEFAULT 'awaiting_scheduling',
          title text NOT NULL,
          fault_description text NOT NULL,
          warranty_status text NOT NULL DEFAULT 'unknown',
          product_type text,
          product_model text,
          serial_number text,
          priority text NOT NULL DEFAULT 'normal',
          source text NOT NULL DEFAULT 'manual',
          created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          closed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, reference),
          FOREIGN KEY (tenant_id, customer_contact_id)
            REFERENCES crm.contacts(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, reporting_contact_id)
            REFERENCES crm.contacts(tenant_id, id) ON DELETE SET NULL (reporting_contact_id),
          FOREIGN KEY (tenant_id, service_location_id)
            REFERENCES crm.service_locations(tenant_id, id)
              ON DELETE SET NULL (service_location_id),
          FOREIGN KEY (tenant_id, intake_draft_id)
            REFERENCES service.intake_drafts(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, conversation_id)
            REFERENCES messaging.conversations(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_service_case_status CHECK (
            status IN ('awaiting_scheduling','scheduled','in_progress',
              'completed','closed','cancelled')
          ),
          CONSTRAINT ck_service_case_warranty CHECK (
            warranty_status IN ('unknown','yes','no')
          ),
          CONSTRAINT ck_service_case_priority CHECK (
            priority IN ('low','normal','high','urgent')
          ),
          CONSTRAINT ck_service_case_source CHECK (
            source IN ('manual','whatsapp')
          ),
          CONSTRAINT ck_service_case_required_text CHECK (
            length(btrim(title)) BETWEEN 1 AND 200 AND
            length(btrim(fault_description)) BETWEEN 1 AND 10000
          )
        )
    """)
    op.execute("""
        CREATE INDEX ix_service_cases_queue
        ON service.cases(tenant_id, status, updated_at DESC, id DESC)
    """)
    op.execute("""
        CREATE INDEX ix_service_cases_customer
        ON service.cases(tenant_id, customer_contact_id, created_at DESC, id DESC)
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_service_case_intake
        ON service.cases(tenant_id, intake_draft_id)
        WHERE intake_draft_id IS NOT NULL
    """)
    op.execute("""
        CREATE TABLE service.case_status_history (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          case_id uuid NOT NULL,
          from_status text,
          to_status text NOT NULL,
          reason text,
          actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          actor_service text,
          occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          FOREIGN KEY (tenant_id, case_id)
            REFERENCES service.cases(tenant_id, id) ON DELETE CASCADE,
          CONSTRAINT ck_case_history_actor CHECK (
            num_nonnulls(actor_user_id, actor_service) = 1
          )
        )
    """)

    op.execute("""
        CREATE TABLE service.appointments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          case_id uuid NOT NULL,
          technician_id uuid NOT NULL,
          starts_at timestamptz NOT NULL,
          ends_at timestamptz NOT NULL,
          timezone text NOT NULL,
          notes text,
          status text NOT NULL DEFAULT 'scheduled',
          source text NOT NULL DEFAULT 'manual',
          approval_status text NOT NULL DEFAULT 'approved',
          external_provider text,
          external_event_id text,
          idempotency_key text NOT NULL,
          created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, case_id, technician_id, id),
          UNIQUE (tenant_id, idempotency_key),
          FOREIGN KEY (tenant_id, case_id)
            REFERENCES service.cases(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, technician_id)
            REFERENCES service.technicians(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_appointment_time CHECK (ends_at > starts_at),
          CONSTRAINT ck_appointment_status CHECK (
            status IN ('suggested','scheduled','in_progress','completed','cancelled')
          ),
          CONSTRAINT ck_appointment_source CHECK (
            source IN ('manual','ai_suggestion','calendar')
          ),
          CONSTRAINT ck_appointment_approval CHECK (
            approval_status IN ('pending','approved','rejected')
          ),
          CONSTRAINT ck_appointment_external_shape CHECK (
            external_event_id IS NULL OR nullif(btrim(external_provider), '') IS NOT NULL
          )
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_appointment_external_event
        ON service.appointments(tenant_id, external_provider, external_event_id)
        WHERE external_event_id IS NOT NULL
    """)
    op.execute("""
        CREATE INDEX ix_appointment_technician_time
        ON service.appointments(tenant_id, technician_id, starts_at, ends_at)
        WHERE status IN ('scheduled','in_progress')
    """)
    op.execute("""
        CREATE TABLE service.appointment_history (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          appointment_id uuid NOT NULL,
          action text NOT NULL,
          previous_values jsonb NOT NULL DEFAULT '{}'::jsonb,
          new_values jsonb NOT NULL DEFAULT '{}'::jsonb,
          actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          actor_service text,
          occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          FOREIGN KEY (tenant_id, appointment_id)
            REFERENCES service.appointments(tenant_id, id) ON DELETE CASCADE,
          CONSTRAINT ck_appointment_history_actor CHECK (
            num_nonnulls(actor_user_id, actor_service) = 1
          )
        )
    """)

    op.execute("""
        CREATE TABLE service.visits (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          case_id uuid NOT NULL,
          appointment_id uuid,
          technician_id uuid NOT NULL,
          visit_number integer NOT NULL,
          status text NOT NULL DEFAULT 'assigned',
          arrival_at timestamptz,
          arrival_signature_object_id uuid,
          arrival_identity jsonb,
          departure_at timestamptz,
          departure_signature_object_id uuid,
          departure_identity jsonb,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, case_id, id),
          UNIQUE (tenant_id, case_id, visit_number),
          FOREIGN KEY (tenant_id, case_id)
            REFERENCES service.cases(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, case_id, technician_id, appointment_id)
            REFERENCES service.appointments(tenant_id, case_id, technician_id, id)
            ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, technician_id)
            REFERENCES service.technicians(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, arrival_signature_object_id)
            REFERENCES objects.object_metadata(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, departure_signature_object_id)
            REFERENCES objects.object_metadata(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_visit_number CHECK (visit_number > 0),
          CONSTRAINT ck_visit_status CHECK (
            status IN ('assigned','arrived','departed','reported','cancelled')
          ),
          CONSTRAINT ck_visit_arrival_shape CHECK (
            num_nonnulls(arrival_at, arrival_signature_object_id, arrival_identity) IN (0,3)
          ),
          CONSTRAINT ck_visit_departure_shape CHECK (
            num_nonnulls(departure_at, departure_signature_object_id, departure_identity) IN (0,3)
          ),
          CONSTRAINT ck_visit_attendance_order CHECK (
            departure_at IS NULL OR (arrival_at IS NOT NULL AND departure_at >= arrival_at)
          )
        )
    """)
    op.execute("""
        CREATE TABLE service.technician_session_identities (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          auth_session_id uuid NOT NULL
            REFERENCES platform.auth_sessions(id) ON DELETE CASCADE,
          visit_id uuid NOT NULL,
          technician_id uuid NOT NULL,
          full_name text NOT NULL,
          employee_identifier text,
          contact_information text,
          verification_state text NOT NULL DEFAULT 'self_declared',
          server_nonce text NOT NULL,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, auth_session_id, visit_id),
          FOREIGN KEY (tenant_id, visit_id)
            REFERENCES service.visits(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, technician_id)
            REFERENCES service.technicians(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_technician_session_verification CHECK (
            verification_state IN ('self_declared','verified')
          ),
          CONSTRAINT ck_technician_session_expiry CHECK (
            expires_at > created_at
          )
        )
    """)

    op.execute("""
        CREATE TABLE service.reports (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          case_id uuid NOT NULL,
          visit_id uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, visit_id),
          FOREIGN KEY (tenant_id, case_id)
            REFERENCES service.cases(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, case_id, visit_id)
            REFERENCES service.visits(tenant_id, case_id, id) ON DELETE RESTRICT
        )
    """)
    op.execute("""
        CREATE TABLE service.report_revisions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          report_id uuid NOT NULL,
          version integer NOT NULL,
          status text NOT NULL DEFAULT 'draft',
          customer_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
          product_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
          diagnosis text,
          work_performed text,
          part_replaced boolean,
          replacement_part_details text,
          technician_notes text,
          manual_corrections jsonb NOT NULL DEFAULT '{}'::jsonb,
          branding_snapshot jsonb,
          finalized_at timestamptz,
          finalized_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          supersedes_revision_id uuid,
          created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, report_id, version),
          FOREIGN KEY (tenant_id, report_id)
            REFERENCES service.reports(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, supersedes_revision_id)
            REFERENCES service.report_revisions(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_report_revision_version CHECK (version > 0),
          CONSTRAINT ck_report_revision_status CHECK (
            status IN ('draft','review_required','finalized','superseded')
          ),
          CONSTRAINT ck_report_replacement_details CHECK (
            part_replaced IS DISTINCT FROM true OR
            length(btrim(replacement_part_details)) BETWEEN 1 AND 2000
          ),
          CONSTRAINT ck_report_finalization_shape CHECK (
            (status = 'finalized' AND finalized_at IS NOT NULL
              AND branding_snapshot IS NOT NULL)
            OR status <> 'finalized'
          )
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_report_editable_revision
        ON service.report_revisions(tenant_id, report_id)
        WHERE status IN ('draft','review_required')
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_report_finalized_revision
        ON service.report_revisions(tenant_id, report_id)
        WHERE status = 'finalized'
    """)
    op.execute("""
        CREATE TABLE service.report_attachments (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          case_id uuid NOT NULL,
          visit_id uuid,
          report_revision_id uuid,
          message_id uuid,
          object_id uuid NOT NULL,
          category text NOT NULL,
          source text NOT NULL,
          processing_status text NOT NULL DEFAULT 'available',
          caption text,
          created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, object_id, case_id),
          FOREIGN KEY (tenant_id, case_id)
            REFERENCES service.cases(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, visit_id)
            REFERENCES service.visits(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, report_revision_id)
            REFERENCES service.report_revisions(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, message_id)
            REFERENCES messaging.messages(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, object_id)
            REFERENCES objects.object_metadata(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_report_attachment_category CHECK (
            category IN ('fault','module','product_label','repair','environment',
              'document','customer_photo','arrival_signature','departure_signature')
          ),
          CONSTRAINT ck_report_attachment_source CHECK (
            source IN ('customer','technician','operator','system')
          ),
          CONSTRAINT ck_report_attachment_status CHECK (
            processing_status IN ('pending','available','failed','quarantined')
          )
        )
    """)
    op.execute("""
        CREATE INDEX ix_report_attachments_context
        ON service.report_attachments(
          tenant_id, case_id, report_revision_id, category, created_at
        )
    """)
    op.execute("""
        CREATE TABLE service.ocr_results (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          attachment_id uuid NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          proposed_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
          confirmed_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
          manually_confirmed_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
          confidence numeric(5,4),
          provider text,
          model text,
          source_checksum text NOT NULL,
          provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
          attempt integer NOT NULL DEFAULT 1,
          error_safe text,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at timestamptz,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, attachment_id, attempt),
          FOREIGN KEY (tenant_id, attachment_id)
            REFERENCES service.report_attachments(tenant_id, id) ON DELETE CASCADE,
          CONSTRAINT ck_ocr_status CHECK (
            status IN ('pending','processing','review_required','confirmed','failed')
          ),
          CONSTRAINT ck_ocr_confidence CHECK (
            confidence IS NULL OR confidence BETWEEN 0 AND 1
          ),
          CONSTRAINT ck_ocr_attempt CHECK (attempt > 0)
        )
    """)

    op.execute("""
        CREATE TABLE service.case_conversations (
          tenant_id uuid NOT NULL,
          case_id uuid NOT NULL,
          conversation_id uuid NOT NULL,
          relationship text NOT NULL DEFAULT 'relevant',
          linked_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          linked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (tenant_id, case_id, conversation_id),
          FOREIGN KEY (tenant_id, case_id)
            REFERENCES service.cases(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, conversation_id)
            REFERENCES messaging.conversations(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_case_conversation_relationship CHECK (
            relationship IN ('intake','relevant','resolved_ambiguity')
          )
        )
    """)
    op.execute("""
        CREATE TABLE service.case_calls (
          tenant_id uuid NOT NULL,
          case_id uuid NOT NULL,
          session_id uuid NOT NULL,
          relationship text NOT NULL DEFAULT 'relevant',
          linked_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          linked_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (tenant_id, case_id, session_id),
          FOREIGN KEY (tenant_id, case_id)
            REFERENCES service.cases(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, session_id)
            REFERENCES public.sessions(tenant_id, session_id) ON DELETE RESTRICT,
          CONSTRAINT ck_case_call_relationship CHECK (
            relationship IN ('intake','diagnostic','follow_up','resolved_ambiguity')
          )
        )
    """)
    op.execute("""
        CREATE TABLE service.case_summaries (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          case_id uuid NOT NULL,
          source_kind text NOT NULL,
          source_reference_id uuid,
          source_checksum text,
          status text NOT NULL DEFAULT 'pending',
          summary text,
          provider text,
          model text,
          error_safe text,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at timestamptz,
          UNIQUE (tenant_id, id),
          FOREIGN KEY (tenant_id, case_id)
            REFERENCES service.cases(tenant_id, id) ON DELETE CASCADE,
          CONSTRAINT ck_case_summary_source CHECK (
            source_kind IN ('whatsapp','call','dossier')
          ),
          CONSTRAINT ck_case_summary_status CHECK (
            status IN ('pending','processing','completed','failed','unavailable')
          ),
          CONSTRAINT ck_case_summary_material CHECK (
            status <> 'completed' OR
              (nullif(btrim(summary), '') IS NOT NULL AND source_checksum IS NOT NULL)
          )
        )
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_case_summary_source
        ON service.case_summaries(
          tenant_id, case_id, source_kind, source_reference_id
        ) WHERE source_reference_id IS NOT NULL
    """)
    op.execute("""
        CREATE TABLE service.export_records (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          case_id uuid NOT NULL,
          format text NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          object_id uuid,
          branding_snapshot jsonb NOT NULL,
          requested_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
          error_safe text,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at timestamptz,
          UNIQUE (tenant_id, id),
          FOREIGN KEY (tenant_id, case_id)
            REFERENCES service.cases(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, object_id)
            REFERENCES objects.object_metadata(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_service_export_format CHECK (
            format IN ('html','csv','xlsx','pdf','zip')
          ),
          CONSTRAINT ck_service_export_status CHECK (
            status IN ('pending','processing','available','failed')
          ),
          CONSTRAINT ck_service_export_object CHECK (
            status <> 'available' OR object_id IS NOT NULL
          )
        )
    """)

    op.execute("""
        CREATE FUNCTION service.prevent_finalized_report_mutation()
        RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        BEGIN
          IF TG_OP = 'DELETE' AND OLD.status IN ('finalized','superseded') THEN
            RAISE EXCEPTION 'finalized report revisions are immutable'
              USING ERRCODE = '55000';
          END IF;
          IF TG_OP = 'UPDATE' AND OLD.status = 'superseded' THEN
            RAISE EXCEPTION 'superseded report revisions are immutable'
              USING ERRCODE = '55000';
          END IF;
          IF TG_OP = 'UPDATE' AND OLD.status = 'finalized' AND (
            NEW.status <> 'superseded'
            OR (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM
               (to_jsonb(OLD) - 'status' - 'updated_at')
          ) THEN
            RAISE EXCEPTION 'finalized report revisions are immutable'
              USING ERRCODE = '55000';
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER trg_protect_finalized_report_revision
        BEFORE UPDATE OR DELETE ON service.report_revisions
        FOR EACH ROW EXECUTE FUNCTION service.prevent_finalized_report_mutation()
    """)
    op.execute("""
        CREATE FUNCTION service.prevent_signed_visit_mutation()
        RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        BEGIN
          IF OLD.arrival_signature_object_id IS NOT NULL AND (
            NEW.arrival_signature_object_id IS DISTINCT FROM OLD.arrival_signature_object_id
            OR NEW.arrival_at IS DISTINCT FROM OLD.arrival_at
            OR NEW.arrival_identity IS DISTINCT FROM OLD.arrival_identity
          ) THEN
            RAISE EXCEPTION 'signed arrival attendance is immutable'
              USING ERRCODE = '55000';
          END IF;
          IF OLD.departure_signature_object_id IS NOT NULL AND (
            NEW.departure_signature_object_id IS DISTINCT FROM OLD.departure_signature_object_id
            OR NEW.departure_at IS DISTINCT FROM OLD.departure_at
            OR NEW.departure_identity IS DISTINCT FROM OLD.departure_identity
          ) THEN
            RAISE EXCEPTION 'signed departure attendance is immutable'
              USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER trg_protect_signed_visit
        BEFORE UPDATE ON service.visits
        FOR EACH ROW EXECUTE FUNCTION service.prevent_signed_visit_mutation()
    """)
    op.execute("""
        CREATE FUNCTION service.validate_report_attachment_context()
        RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        DECLARE v_owner_type text; v_owner_id uuid; v_content_type text;
        BEGIN
          IF NEW.visit_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM service.visits visit
            WHERE visit.tenant_id=NEW.tenant_id AND visit.id=NEW.visit_id
              AND visit.case_id=NEW.case_id
          ) THEN
            RAISE EXCEPTION 'attachment visit does not belong to the case'
              USING ERRCODE = '23514';
          END IF;
          IF NEW.report_revision_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM service.report_revisions revision
            JOIN service.reports report
              ON report.tenant_id=revision.tenant_id AND report.id=revision.report_id
            WHERE revision.tenant_id=NEW.tenant_id
              AND revision.id=NEW.report_revision_id
              AND report.case_id=NEW.case_id
              AND (NEW.visit_id IS NULL OR report.visit_id=NEW.visit_id)
              AND revision.status IN ('draft','review_required')
          ) THEN
            RAISE EXCEPTION
              'attachment report revision is not editable or does not match the case visit'
              USING ERRCODE = '23514';
          END IF;
          IF NEW.category IN ('arrival_signature','departure_signature') AND (
            NEW.visit_id IS NULL OR NEW.source <> 'technician'
          ) THEN
            RAISE EXCEPTION 'attendance signatures require a technician visit'
              USING ERRCODE = '23514';
          END IF;
          SELECT owner_type, owner_id, content_type
          INTO v_owner_type, v_owner_id, v_content_type
          FROM objects.object_metadata object
          WHERE object.tenant_id=NEW.tenant_id AND object.id=NEW.object_id
            AND object.deleted_at IS NULL;
          IF v_owner_type = 'service_case' AND v_owner_id <> NEW.case_id THEN
            RAISE EXCEPTION 'attachment object does not belong to the case'
              USING ERRCODE = '23514';
          END IF;
          IF v_owner_type = 'message' AND (
            NEW.message_id IS NULL OR v_owner_id <> NEW.message_id
          ) THEN
            RAISE EXCEPTION 'message attachment object does not match its source message'
              USING ERRCODE = '23514';
          END IF;
          IF v_owner_type NOT IN ('service_case','message') THEN
            RAISE EXCEPTION 'unsupported service attachment owner'
              USING ERRCODE = '23514';
          END IF;
          IF NEW.category IN (
            'fault','module','product_label','repair','environment',
            'customer_photo','arrival_signature','departure_signature'
          ) AND v_content_type NOT IN ('image/jpeg','image/png','image/webp') THEN
            RAISE EXCEPTION 'this evidence category requires an image'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER trg_validate_report_attachment_context
        BEFORE INSERT OR UPDATE ON service.report_attachments
        FOR EACH ROW EXECUTE FUNCTION service.validate_report_attachment_context()
    """)
    op.execute("""
        CREATE FUNCTION service.prevent_appointment_conflict()
        RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        BEGIN
          IF NEW.status NOT IN ('scheduled','in_progress') THEN RETURN NEW; END IF;
          PERFORM pg_advisory_xact_lock(
            hashtextextended(NEW.tenant_id::text || ':' || NEW.technician_id::text, 0)
          );
          IF EXISTS (
            SELECT 1 FROM service.appointments existing
            WHERE existing.tenant_id = NEW.tenant_id
              AND existing.technician_id = NEW.technician_id
              AND existing.id <> NEW.id
              AND existing.status IN ('scheduled','in_progress')
              AND tstzrange(existing.starts_at, existing.ends_at, '[)') &&
                  tstzrange(NEW.starts_at, NEW.ends_at, '[)')
          ) THEN
            RAISE EXCEPTION 'technician already has a conflicting appointment'
              USING ERRCODE = '23P01';
          END IF;
          RETURN NEW;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER trg_prevent_appointment_conflict
        BEFORE INSERT OR UPDATE OF technician_id, starts_at, ends_at, status
        ON service.appointments
        FOR EACH ROW EXECUTE FUNCTION service.prevent_appointment_conflict()
    """)

    # Summaries consume canonical, already-persisted CRM evidence. These
    # security-definer trigger adapters do not trust payload tenant identifiers:
    # tenant, case and source relationships are all re-established by joins.
    op.execute("""
        CREATE FUNCTION service.enqueue_whatsapp_case_summary(
          p_tenant_id uuid, p_case_id uuid, p_conversation_id uuid, p_cause text
        ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        DECLARE v_summary_id uuid;
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM platform.tenant_feature_entitlements entitlement
            JOIN service.tenant_configuration configuration
              ON configuration.tenant_id=entitlement.tenant_id
            JOIN service.case_conversations link
              ON link.tenant_id=entitlement.tenant_id
             AND link.case_id=p_case_id
             AND link.conversation_id=p_conversation_id
            WHERE entitlement.tenant_id=p_tenant_id
              AND entitlement.feature_key='field_service'
              AND entitlement.available AND configuration.enabled
          ) THEN
            RETURN;
          END IF;

          INSERT INTO service.case_summaries(
            tenant_id, case_id, source_kind, source_reference_id, status
          ) VALUES (
            p_tenant_id, p_case_id, 'whatsapp', p_conversation_id, 'pending'
          )
          ON CONFLICT (tenant_id, case_id, source_kind, source_reference_id)
            WHERE source_reference_id IS NOT NULL
          DO UPDATE SET status='pending', summary=NULL, source_checksum=NULL,
            provider=NULL, model=NULL, error_safe=NULL, completed_at=NULL
          RETURNING id INTO v_summary_id;

          INSERT INTO ops.jobs(
            tenant_id, queue, job_type, reference_type, reference_id, payload,
            idempotency_key, max_attempts, priority
          ) VALUES (
            p_tenant_id, 'messaging', 'field_service.summary', 'case_summary',
            v_summary_id,
            jsonb_build_object(
              'summaryId',v_summary_id,'caseId',p_case_id,
              'sourceKind','whatsapp','sourceReferenceId',p_conversation_id
            ),
            'field-service:summary:whatsapp:' || p_case_id::text || ':' ||
              p_conversation_id::text || ':' || p_cause,
            4, 10
          ) ON CONFLICT DO NOTHING;
        END
        $$
    """)
    op.execute("""
        CREATE FUNCTION service.queue_whatsapp_summary_from_message()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        DECLARE v_case_id uuid;
        BEGIN
          FOR v_case_id IN
            SELECT link.case_id
            FROM service.case_conversations link
            WHERE link.tenant_id=NEW.tenant_id
              AND link.conversation_id=NEW.conversation_id
          LOOP
            PERFORM service.enqueue_whatsapp_case_summary(
              NEW.tenant_id, v_case_id, NEW.conversation_id, NEW.id::text
            );
          END LOOP;
          RETURN NEW;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER trg_queue_whatsapp_case_summary_message
        AFTER INSERT ON messaging.messages
        FOR EACH ROW EXECUTE FUNCTION service.queue_whatsapp_summary_from_message()
    """)
    op.execute("""
        CREATE FUNCTION service.queue_whatsapp_summary_from_link()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        BEGIN
          PERFORM service.enqueue_whatsapp_case_summary(
            NEW.tenant_id, NEW.case_id, NEW.conversation_id,
            'link-' || NEW.case_id::text
          );
          RETURN NEW;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER trg_queue_whatsapp_case_summary_link
        AFTER INSERT ON service.case_conversations
        FOR EACH ROW EXECUTE FUNCTION service.queue_whatsapp_summary_from_link()
    """)
    op.execute("""
        CREATE FUNCTION service.enqueue_call_case_summary(
          p_tenant_id uuid, p_case_id uuid, p_session_id uuid
        ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        DECLARE v_summary_id uuid; v_status text; v_transcript_id uuid;
                v_checksum text; v_summary_status text; v_error text;
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM platform.tenant_feature_entitlements entitlement
            JOIN service.tenant_configuration configuration
              ON configuration.tenant_id=entitlement.tenant_id
            JOIN service.case_calls link
              ON link.tenant_id=entitlement.tenant_id
             AND link.case_id=p_case_id AND link.session_id=p_session_id
            WHERE entitlement.tenant_id=p_tenant_id
              AND entitlement.feature_key='field_service'
              AND entitlement.available AND configuration.enabled
          ) THEN
            RETURN;
          END IF;

          SELECT session.status::text, session.transcript_object_id,
                 object.checksum
          INTO v_status, v_transcript_id, v_checksum
          FROM public.sessions session
          LEFT JOIN objects.object_metadata object
            ON object.tenant_id=session.tenant_id
           AND object.id=session.transcript_object_id
           AND object.status='available' AND object.deleted_at IS NULL
          WHERE session.tenant_id=p_tenant_id AND session.session_id=p_session_id;
          IF NOT FOUND THEN RETURN; END IF;

          IF v_transcript_id IS NOT NULL AND v_checksum IS NOT NULL THEN
            v_summary_status := 'pending'; v_error := NULL;
          ELSIF v_status IN ('ended','failed') THEN
            v_summary_status := 'unavailable';
            v_error := 'call_transcript_unavailable';
          ELSE
            v_summary_status := 'pending'; v_error := NULL;
          END IF;

          INSERT INTO service.case_summaries(
            tenant_id, case_id, source_kind, source_reference_id,
            source_checksum, status, error_safe, completed_at
          ) VALUES (
            p_tenant_id, p_case_id, 'call', p_session_id, v_checksum,
            v_summary_status, v_error,
            CASE WHEN v_summary_status='unavailable'
              THEN CURRENT_TIMESTAMP ELSE NULL END
          )
          ON CONFLICT (tenant_id, case_id, source_kind, source_reference_id)
            WHERE source_reference_id IS NOT NULL
          DO UPDATE SET source_checksum=EXCLUDED.source_checksum,
            status=EXCLUDED.status, summary=NULL, provider=NULL, model=NULL,
            error_safe=EXCLUDED.error_safe, completed_at=EXCLUDED.completed_at
          RETURNING id INTO v_summary_id;

          IF v_summary_status='pending' AND v_checksum IS NOT NULL THEN
            INSERT INTO ops.jobs(
              tenant_id, queue, job_type, reference_type, reference_id, payload,
              idempotency_key, max_attempts, priority
            ) VALUES (
              p_tenant_id, 'messaging', 'field_service.summary', 'case_summary',
              v_summary_id,
              jsonb_build_object(
                'summaryId',v_summary_id,'caseId',p_case_id,
                'sourceKind','call','sourceReferenceId',p_session_id
              ),
              'field-service:summary:call:' || p_case_id::text || ':' || v_checksum,
              4, 10
            ) ON CONFLICT DO NOTHING;
          END IF;
        END
        $$
    """)
    op.execute("""
        CREATE FUNCTION service.queue_call_summary_from_link()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        BEGIN
          PERFORM service.enqueue_call_case_summary(
            NEW.tenant_id, NEW.case_id, NEW.session_id
          );
          RETURN NEW;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER trg_queue_call_case_summary_link
        AFTER INSERT ON service.case_calls
        FOR EACH ROW EXECUTE FUNCTION service.queue_call_summary_from_link()
    """)
    op.execute("""
        CREATE FUNCTION service.queue_call_summary_from_session()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        DECLARE v_case_id uuid;
        BEGIN
          IF NEW.transcript_object_id IS NOT DISTINCT FROM OLD.transcript_object_id
             AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
            RETURN NEW;
          END IF;
          FOR v_case_id IN
            SELECT link.case_id FROM service.case_calls link
            WHERE link.tenant_id=NEW.tenant_id
              AND link.session_id=NEW.session_id
          LOOP
            PERFORM service.enqueue_call_case_summary(
              NEW.tenant_id, v_case_id, NEW.session_id
            );
          END LOOP;
          RETURN NEW;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER trg_queue_call_case_summary_session
        AFTER UPDATE OF status, transcript_object_id ON public.sessions
        FOR EACH ROW EXECUTE FUNCTION service.queue_call_summary_from_session()
    """)

    op.execute("""
        CREATE FUNCTION service.field_service_enabled()
        RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
          SELECT coalesce((
            SELECT entitlement.available AND configuration.enabled
            FROM platform.tenant_feature_entitlements entitlement
            JOIN service.tenant_configuration configuration
              ON configuration.tenant_id = entitlement.tenant_id
            WHERE entitlement.tenant_id = platform.current_tenant_id()
              AND entitlement.feature_key = 'field_service'
          ), false)
        $$
    """)
    op.execute("""
        CREATE FUNCTION service.current_actor_can_access_case(p_case_id uuid)
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
        CREATE FUNCTION service.current_actor_can_access_technician(
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
    op.execute("""
        CREATE FUNCTION service.current_actor_can_access_object(
          p_tenant_id uuid, p_object_id uuid, p_owner_type text, p_owner_id uuid
        ) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog AS $$
          SELECT CASE
            WHEN p_tenant_id IS DISTINCT FROM platform.current_tenant_id()
              THEN false
            WHEN coalesce(current_setting('app.current_role', true), '') <> 'technician'
              THEN true
            WHEN p_owner_type = 'service_case'
              THEN service.current_actor_can_access_case(p_owner_id)
            WHEN p_owner_type = 'message' THEN EXISTS (
              SELECT 1 FROM service.report_attachments scoped_attachment
              WHERE scoped_attachment.object_id = p_object_id
                AND scoped_attachment.tenant_id = p_tenant_id
                AND service.current_actor_can_access_case(scoped_attachment.case_id)
            )
            WHEN p_owner_type = 'contact' THEN EXISTS (
              SELECT 1 FROM crm.customer_documents customer_document
              JOIN service.cases scoped_case
                ON scoped_case.customer_contact_id=customer_document.contact_id
               AND scoped_case.tenant_id=customer_document.tenant_id
              WHERE customer_document.object_id=p_object_id
                AND customer_document.tenant_id=p_tenant_id
                AND customer_document.deleted_at IS NULL
                AND service.current_actor_can_access_case(scoped_case.id)
            )
            ELSE false
          END
        $$
    """)
    op.execute("""
        CREATE FUNCTION platform.set_tenant_feature_entitlement(
          p_tenant_id uuid, p_available boolean, p_request_id text
        ) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        DECLARE v_actor uuid := platform.current_user_id(); v_enabled boolean;
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM public.users
            WHERE id = v_actor AND status = 'active' AND is_superuser
          ) THEN
            RAISE EXCEPTION 'platform administrator permission required'
              USING ERRCODE = '42501';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM public.tenants WHERE id = p_tenant_id AND status = 'active'
          ) THEN
            RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'P0002';
          END IF;
          INSERT INTO platform.tenant_feature_entitlements(
            tenant_id, feature_key, available, granted_by_user_id, granted_at
          ) VALUES (
            p_tenant_id, 'field_service', p_available,
            CASE WHEN p_available THEN v_actor ELSE NULL END,
            CASE WHEN p_available THEN CURRENT_TIMESTAMP ELSE NULL END
          ) ON CONFLICT (tenant_id, feature_key) DO UPDATE SET
            available = EXCLUDED.available,
            granted_by_user_id = EXCLUDED.granted_by_user_id,
            granted_at = EXCLUDED.granted_at,
            updated_at = CURRENT_TIMESTAMP;
          INSERT INTO service.tenant_configuration(tenant_id)
          VALUES (p_tenant_id) ON CONFLICT (tenant_id) DO NOTHING;
          IF NOT p_available THEN
            UPDATE service.tenant_configuration
            SET enabled = false, changed_by_user_id = v_actor,
                changed_at = CURRENT_TIMESTAMP
            WHERE tenant_id = p_tenant_id;
          END IF;
          SELECT enabled INTO v_enabled FROM service.tenant_configuration
          WHERE tenant_id = p_tenant_id;
          INSERT INTO service.feature_change_history(
            tenant_id, actor_user_id, available, enabled, settings, request_id
          ) SELECT p_tenant_id, v_actor, p_available, v_enabled,
            jsonb_build_object('change','entitlement'), p_request_id;
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            p_tenant_id, v_actor, 'tenant.feature.entitlement.updated',
            'tenant', p_tenant_id, p_request_id,
            jsonb_build_object('feature','field_service','available',p_available)
          );
        END
        $$
    """)
    op.execute("""
        CREATE FUNCTION platform.list_tenant_field_service_entitlements_for_administrator()
        RETURNS TABLE(tenant_id uuid, available boolean, enabled boolean)
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog AS $$
          SELECT tenant.id,
                 coalesce(entitlement.available, false),
                 coalesce(configuration.enabled, false)
          FROM public.tenants tenant
          LEFT JOIN platform.tenant_feature_entitlements entitlement
            ON entitlement.tenant_id = tenant.id
           AND entitlement.feature_key = 'field_service'
          LEFT JOIN service.tenant_configuration configuration
            ON configuration.tenant_id = tenant.id
          WHERE tenant.status <> 'deleted'
            AND EXISTS (
              SELECT 1 FROM public.users actor
              WHERE actor.id = nullif(
                      current_setting('app.current_user', true), ''
                    )::uuid
                AND actor.status = 'active'
                AND actor.is_superuser
            )
          ORDER BY tenant.created_at DESC, tenant.id DESC
        $$
    """)
    op.execute("""
        CREATE FUNCTION service.configure_current_tenant(
          p_enabled boolean, p_whatsapp_intake boolean,
          p_ai_scheduling boolean, p_ocr boolean, p_shared_login boolean,
          p_ai_schedule_requires_approval boolean,
          p_calendar_access text, p_calendar_provider text,
          p_request_id text
        ) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id();
                v_actor uuid := platform.current_user_id();
                v_available boolean;
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM public.users actor
            LEFT JOIN public.memberships membership
              ON membership.user_id = actor.id AND membership.tenant_id = v_tenant
            WHERE actor.id = v_actor AND actor.status = 'active'
              AND (actor.is_superuser OR membership.role IN ('owner','admin','editor'))
          ) THEN
            RAISE EXCEPTION 'tenant management permission required'
              USING ERRCODE = '42501';
          END IF;
          SELECT available INTO v_available
          FROM platform.tenant_feature_entitlements
          WHERE tenant_id = v_tenant AND feature_key = 'field_service';
          IF p_enabled AND NOT coalesce(v_available, false) THEN
            RAISE EXCEPTION 'field service is not available for this tenant'
              USING ERRCODE = '42501';
          END IF;
          IF p_calendar_access NOT IN ('none','read_only','write') THEN
            RAISE EXCEPTION 'invalid field-service calendar access'
              USING ERRCODE = '22023';
          END IF;
          IF (p_calendar_access = 'none' AND p_calendar_provider IS NOT NULL)
             OR (p_calendar_access <> 'none' AND p_calendar_provider <> 'crm_calendar') THEN
            RAISE EXCEPTION 'unsupported field-service calendar provider'
              USING ERRCODE = '22023';
          END IF;
          IF p_ai_scheduling AND p_calendar_access = 'none' THEN
            RAISE EXCEPTION 'AI scheduling requires readable calendar access'
              USING ERRCODE = '22023';
          END IF;
          INSERT INTO service.tenant_configuration(
            tenant_id, enabled, whatsapp_intake_enabled,
            ai_scheduling_enabled, ocr_enabled,
            shared_technician_login_enabled, ai_schedule_requires_approval,
            calendar_access, calendar_provider, changed_by_user_id
          ) VALUES (
            v_tenant, p_enabled, p_whatsapp_intake, p_ai_scheduling,
            p_ocr, p_shared_login, p_ai_schedule_requires_approval,
            p_calendar_access, p_calendar_provider, v_actor
          ) ON CONFLICT (tenant_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            whatsapp_intake_enabled = EXCLUDED.whatsapp_intake_enabled,
            ai_scheduling_enabled = EXCLUDED.ai_scheduling_enabled,
            ocr_enabled = EXCLUDED.ocr_enabled,
            shared_technician_login_enabled = EXCLUDED.shared_technician_login_enabled,
            ai_schedule_requires_approval = EXCLUDED.ai_schedule_requires_approval,
            calendar_access = EXCLUDED.calendar_access,
            calendar_provider = EXCLUDED.calendar_provider,
            changed_by_user_id = EXCLUDED.changed_by_user_id,
            changed_at = CURRENT_TIMESTAMP;
          INSERT INTO service.feature_change_history(
            tenant_id, actor_user_id, available, enabled, settings, request_id
          ) VALUES (
            v_tenant, v_actor, coalesce(v_available, false), p_enabled,
            jsonb_build_object(
              'whatsappIntake',p_whatsapp_intake,
              'aiScheduling',p_ai_scheduling,
              'ocr',p_ocr,'sharedLogin',p_shared_login,
              'aiScheduleRequiresApproval',p_ai_schedule_requires_approval,
              'calendarAccess',p_calendar_access,
              'calendarProvider',p_calendar_provider
            ), p_request_id
          );
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id,
            request_id, metadata
          ) VALUES (
            v_tenant, v_actor, 'tenant.feature.configuration.updated',
            'tenant', v_tenant, p_request_id,
            jsonb_build_object(
              'feature','field_service','enabled',p_enabled,
              'whatsappIntake',p_whatsapp_intake,
              'aiScheduling',p_ai_scheduling,
              'ocr',p_ocr,'sharedLogin',p_shared_login,
              'aiScheduleRequiresApproval',p_ai_schedule_requires_approval,
              'calendarAccess',p_calendar_access,
              'calendarProvider',p_calendar_provider
            )
          );
        END
        $$
    """)

    _tenant_policy("platform", "tenant_feature_entitlements")
    for table in ("customer_profiles", "customer_classifications", "contact_classifications"):
        _tenant_policy("crm", table)
    _tenant_policy("crm", "service_locations")
    _tenant_policy("crm", "customer_documents")
    for table in SERVICE_TABLES:
        _tenant_policy("service", table)

    for table in (
        "technicians",
        "intake_drafts",
        "intake_messages",
        "cases",
        "case_status_history",
        "appointments",
        "appointment_history",
        "visits",
        "technician_session_identities",
        "reports",
        "report_revisions",
        "report_attachments",
        "ocr_results",
        "case_conversations",
        "case_calls",
        "case_summaries",
    ):
        _feature_mutation_policy(table)

    _technician_scope_policy("technicians", "service.current_actor_can_access_technician(id)")
    _technician_scope_policy("cases", "service.current_actor_can_access_case(id)")
    for table in (
        "case_status_history",
        "appointments",
        "visits",
        "reports",
        "report_attachments",
        "case_conversations",
        "case_calls",
        "case_summaries",
        "export_records",
    ):
        _technician_scope_policy(table, "service.current_actor_can_access_case(case_id)")
    _technician_scope_policy(
        "appointment_history",
        "EXISTS (SELECT 1 FROM service.appointments scoped_appointment "
        "WHERE scoped_appointment.id = appointment_id "
        "AND service.current_actor_can_access_case(scoped_appointment.case_id))",
    )
    _technician_scope_policy(
        "technician_session_identities",
        "EXISTS (SELECT 1 FROM service.visits scoped_visit "
        "WHERE scoped_visit.id = visit_id "
        "AND service.current_actor_can_access_case(scoped_visit.case_id)) "
        "AND (coalesce(current_setting('app.current_role', true), '') <> 'technician' "
        "OR auth_session_id::text = current_setting('app.current_session', true))",
    )
    _technician_scope_policy(
        "report_revisions",
        "EXISTS (SELECT 1 FROM service.reports scoped_report "
        "WHERE scoped_report.id = report_id "
        "AND service.current_actor_can_access_case(scoped_report.case_id))",
    )
    _technician_scope_policy(
        "ocr_results",
        "EXISTS (SELECT 1 FROM service.report_attachments scoped_attachment "
        "WHERE scoped_attachment.id = attachment_id "
        "AND service.current_actor_can_access_case(scoped_attachment.case_id))",
    )
    for table in ("intake_drafts", "intake_messages"):
        _technician_scope_policy(
            table,
            "coalesce(current_setting('app.current_role', true), '') <> 'technician'",
        )
    op.execute("""
        CREATE POLICY object_metadata_field_service_technician_scope
        ON objects.object_metadata AS RESTRICTIVE
        USING (service.current_actor_can_access_object(
          tenant_id, id, owner_type, owner_id
        ))
        WITH CHECK (service.current_actor_can_access_object(
          tenant_id, id, owner_type, owner_id
        ))
    """)

    op.execute("""
        GRANT USAGE ON SCHEMA service
          TO platform_web, platform_worker, platform_messaging,
             platform_voice, platform_readonly
    """)
    op.execute("""
        GRANT SELECT ON platform.tenant_feature_entitlements
          TO platform_web, platform_worker, platform_messaging, platform_readonly
    """)
    op.execute("""
        GRANT SELECT, INSERT, UPDATE, DELETE ON
          crm.customer_profiles, crm.customer_classifications,
          crm.contact_classifications, crm.service_locations,
          crm.customer_documents TO platform_web
    """)
    op.execute("""
        GRANT SELECT ON
          crm.customer_profiles, crm.customer_classifications,
          crm.contact_classifications, crm.service_locations,
          crm.customer_documents TO platform_readonly
    """)
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA service TO platform_web"
    )
    op.execute("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA service TO platform_worker")
    op.execute("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA service TO platform_messaging")
    op.execute("GRANT SELECT ON ALL TABLES IN SCHEMA service TO platform_readonly")
    op.execute("REVOKE ALL ON FUNCTION service.field_service_enabled() FROM PUBLIC")
    op.execute("""
        REVOKE ALL ON FUNCTION
          service.current_actor_can_access_case(uuid),
          service.current_actor_can_access_technician(uuid),
          service.current_actor_can_access_object(uuid,uuid,text,uuid) FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION service.field_service_enabled()
          TO platform_web, platform_worker, platform_messaging, platform_readonly
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION
          service.current_actor_can_access_case(uuid),
          service.current_actor_can_access_technician(uuid),
          service.current_actor_can_access_object(uuid,uuid,text,uuid)
          TO platform_web, platform_worker, platform_messaging,
             platform_voice, platform_readonly
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION
          platform.set_tenant_feature_entitlement(uuid,boolean,text) FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION
          platform.set_tenant_feature_entitlement(uuid,boolean,text) TO platform_web
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION
          platform.list_tenant_field_service_entitlements_for_administrator()
          FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION
          platform.list_tenant_field_service_entitlements_for_administrator()
          TO platform_web
    """)
    op.execute("""
        REVOKE ALL ON FUNCTION
          service.configure_current_tenant(boolean,boolean,boolean,boolean,boolean,
            boolean,text,text,text)
          FROM PUBLIC
    """)
    op.execute("""
        GRANT EXECUTE ON FUNCTION
          service.configure_current_tenant(boolean,boolean,boolean,boolean,boolean,
            boolean,text,text,text)
          TO platform_web
    """)
    op.execute("REVOKE ALL ON FUNCTION service.prevent_finalized_report_mutation() FROM PUBLIC")
    op.execute("REVOKE ALL ON FUNCTION service.prevent_signed_visit_mutation() FROM PUBLIC")
    op.execute("REVOKE ALL ON FUNCTION service.validate_report_attachment_context() FROM PUBLIC")
    op.execute("REVOKE ALL ON FUNCTION service.prevent_appointment_conflict() FROM PUBLIC")
    op.execute("""
        REVOKE ALL ON FUNCTION
          service.enqueue_whatsapp_case_summary(uuid,uuid,uuid,text),
          service.queue_whatsapp_summary_from_message(),
          service.queue_whatsapp_summary_from_link(),
          service.enqueue_call_case_summary(uuid,uuid,uuid),
          service.queue_call_summary_from_link(),
          service.queue_call_summary_from_session()
        FROM PUBLIC
    """)

    op.execute("""
        ALTER TABLE platform.tenant_invitations DROP CONSTRAINT ck_invitation_role
    """)
    op.execute("""
        ALTER TABLE platform.tenant_invitations ADD CONSTRAINT ck_invitation_role
        CHECK (role IN ('owner','admin','agent','viewer','technician'))
    """)
    _restore_member_functions(include_technician=True)


def downgrade() -> None:
    _restore_member_functions(include_technician=False)
    op.execute("ALTER TABLE platform.tenant_invitations DROP CONSTRAINT ck_invitation_role")
    op.execute("""
        ALTER TABLE platform.tenant_invitations ADD CONSTRAINT ck_invitation_role
        CHECK (role IN ('owner','admin','agent','viewer'))
    """)
    op.execute(
        "DROP FUNCTION "
        "service.configure_current_tenant(boolean,boolean,boolean,boolean,boolean,boolean,text,text,text)"
    )
    op.execute("DROP FUNCTION platform.list_tenant_field_service_entitlements_for_administrator()")
    op.execute("DROP FUNCTION platform.set_tenant_feature_entitlement(uuid,boolean,text)")
    op.execute("DROP TRIGGER trg_queue_call_case_summary_session ON public.sessions")
    op.execute("DROP FUNCTION service.queue_call_summary_from_session()")
    op.execute("DROP TRIGGER trg_queue_call_case_summary_link ON service.case_calls")
    op.execute("DROP FUNCTION service.queue_call_summary_from_link()")
    op.execute("DROP FUNCTION service.enqueue_call_case_summary(uuid,uuid,uuid)")
    op.execute("DROP TRIGGER trg_queue_whatsapp_case_summary_link ON service.case_conversations")
    op.execute("DROP FUNCTION service.queue_whatsapp_summary_from_link()")
    op.execute("DROP TRIGGER trg_queue_whatsapp_case_summary_message ON messaging.messages")
    op.execute("DROP FUNCTION service.queue_whatsapp_summary_from_message()")
    op.execute("DROP FUNCTION service.enqueue_whatsapp_case_summary(uuid,uuid,uuid,text)")
    op.execute("DROP TRIGGER trg_prevent_appointment_conflict ON service.appointments")
    op.execute("DROP FUNCTION service.prevent_appointment_conflict()")
    op.execute("DROP TRIGGER trg_validate_report_attachment_context ON service.report_attachments")
    op.execute("DROP FUNCTION service.validate_report_attachment_context()")
    op.execute("DROP TRIGGER trg_protect_signed_visit ON service.visits")
    op.execute("DROP FUNCTION service.prevent_signed_visit_mutation()")
    op.execute("""
        DROP TRIGGER trg_protect_finalized_report_revision ON service.report_revisions
    """)
    op.execute("DROP FUNCTION service.prevent_finalized_report_mutation()")

    op.execute("""
        DROP POLICY object_metadata_field_service_technician_scope
        ON objects.object_metadata
    """)

    for table in reversed(SERVICE_TABLES):
        op.execute(f'DROP TABLE service."{table}"')
    op.execute("DROP FUNCTION service.current_actor_can_access_object(uuid,uuid,text,uuid)")
    op.execute("DROP FUNCTION service.current_actor_can_access_technician(uuid)")
    op.execute("DROP FUNCTION service.current_actor_can_access_case(uuid)")
    op.execute("DROP FUNCTION service.field_service_enabled()")
    op.execute("DROP SCHEMA service")
    for table in (
        "customer_documents",
        "service_locations",
        "contact_classifications",
        "customer_classifications",
        "customer_profiles",
    ):
        op.execute(f'DROP TABLE crm."{table}"')
    op.execute("DROP TABLE platform.tenant_feature_entitlements")
    op.execute("""
        ALTER TABLE crm.tenant_settings
          DROP CONSTRAINT ck_tenant_accent_token,
          DROP COLUMN report_footer,
          DROP COLUMN report_header,
          DROP COLUMN accent_token,
          DROP COLUMN business_address,
          DROP COLUMN business_phone,
          DROP COLUMN business_email,
          DROP COLUMN business_name
    """)
