"""secure tenant-aware WhatsApp to voice handoff context

Revision ID: d7a9e2c4f6b1
Revises: c41e7d9a5b20
Create Date: 2026-09-16 15:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "d7a9e2c4f6b1"
down_revision: str | None = "c41e7d9a5b20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_DEFAULT_POLICY = """jsonb_build_object(
  'schemaVersion', '1.0',
  'enabled', true,
  'requiredFactors', jsonb_build_array('fullName', 'phone', 'nationalId'),
  'maxAttempts', 3,
  'onFailure', 'human_handoff',
  'contextDisclosure', 'after_verification'
)"""


def upgrade() -> None:
    # Tenant identity and verification are data, not provider- or prompt-local
    # assumptions. A profile may grow without another wide-table migration;
    # the security-critical verification policy remains shape constrained.
    op.execute(
        f"""
        ALTER TABLE crm.tenant_settings
          ADD COLUMN support_profile jsonb NOT NULL
            DEFAULT '{{"schemaVersion":"1.0"}}'::jsonb,
          ADD COLUMN identity_verification_policy jsonb NOT NULL
            DEFAULT {_DEFAULT_POLICY}
        """
    )
    op.execute(
        """
        UPDATE crm.tenant_settings settings
        SET support_profile = jsonb_strip_nulls(jsonb_build_object(
          'schemaVersion', '1.0',
          'displayName', coalesce(settings.display_name, tenant.name),
          'supportDisplayName', coalesce(
            settings.business_name, settings.display_name, tenant.name
          ),
          'legalName', null,
          'businessDescription', null,
          'productsAndServices', '[]'::jsonb,
          'authorizedAffiliations', '[]'::jsonb,
          'primaryLanguage', settings.locale,
          'supportedLanguages', jsonb_build_array(settings.locale),
          'timezone', settings.timezone,
          'businessHours', '{}'::jsonb,
          'terminology', '[]'::jsonb
        ))
        FROM public.tenants tenant
        WHERE tenant.id=settings.tenant_id
        """
    )
    op.execute(
        """
        ALTER TABLE crm.tenant_settings
          ADD CONSTRAINT ck_tenant_support_profile_shape CHECK (
            jsonb_typeof(support_profile)='object'
            AND support_profile->>'schemaVersion'='1.0'
            AND (
              NOT support_profile ? 'authorizedAffiliations'
              OR jsonb_typeof(support_profile->'authorizedAffiliations')='array'
            )
            AND (
              NOT support_profile ? 'productsAndServices'
              OR jsonb_typeof(support_profile->'productsAndServices')='array'
            )
            AND (
              NOT support_profile ? 'supportedLanguages'
              OR jsonb_typeof(support_profile->'supportedLanguages')='array'
            )
            AND (
              NOT support_profile ? 'terminology'
              OR jsonb_typeof(support_profile->'terminology')='array'
            )
            AND (
              NOT support_profile ? 'businessHours'
              OR jsonb_typeof(support_profile->'businessHours')='object'
            )
          ),
          ADD CONSTRAINT ck_tenant_identity_verification_policy CHECK (
            jsonb_typeof(identity_verification_policy)='object'
            AND identity_verification_policy->>'schemaVersion'='1.0'
            AND jsonb_typeof(identity_verification_policy->'enabled')='boolean'
            AND jsonb_typeof(identity_verification_policy->'requiredFactors')='array'
            AND jsonb_array_length(identity_verification_policy->'requiredFactors') BETWEEN 1 AND 4
            AND identity_verification_policy->'requiredFactors' <@
              '["fullName","phone","nationalId","customerNumber"]'::jsonb
            AND (identity_verification_policy->>'maxAttempts')::integer BETWEEN 1 AND 10
            AND identity_verification_policy->>'onFailure' IN ('human_handoff','end_call')
            AND identity_verification_policy->>'contextDisclosure'='after_verification'
          )
        """
    )

    op.execute("ALTER TABLE public.sessions ADD COLUMN outcome_detail jsonb")
    op.execute(
        """
        ALTER TABLE public.sessions
          ADD CONSTRAINT ck_sessions_outcome_detail_object CHECK (
            outcome_detail IS NULL OR jsonb_typeof(outcome_detail)='object'
          )
        """
    )

    op.execute(
        """
        CREATE TABLE automation.voice_identity_verifications (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          session_id uuid NOT NULL,
          handoff_id uuid NOT NULL,
          contact_id uuid NOT NULL,
          conversation_id uuid NOT NULL,
          required_factors text[] NOT NULL,
          state text NOT NULL DEFAULT 'session_initializing',
          attempts integer NOT NULL DEFAULT 0,
          max_attempts integer NOT NULL,
          on_failure text NOT NULL,
          context_disclosure text NOT NULL,
          verified_at timestamptz,
          context_unlocked_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (tenant_id, id),
          UNIQUE (tenant_id, session_id),
          UNIQUE (tenant_id, handoff_id),
          FOREIGN KEY (tenant_id, session_id)
            REFERENCES public.sessions(tenant_id, session_id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, handoff_id)
            REFERENCES automation.handoffs(tenant_id, id) ON DELETE CASCADE,
          FOREIGN KEY (tenant_id, contact_id)
            REFERENCES crm.contacts(tenant_id, id) ON DELETE RESTRICT,
          FOREIGN KEY (tenant_id, conversation_id)
            REFERENCES messaging.conversations(tenant_id, id) ON DELETE RESTRICT,
          CONSTRAINT ck_voice_identity_factors CHECK (
            cardinality(required_factors) BETWEEN 1 AND 4
            AND required_factors <@ ARRAY[
              'fullName','phone','nationalId','customerNumber'
            ]::text[]
          ),
          CONSTRAINT ck_voice_identity_state CHECK (
            state IN ('session_initializing','identity_required',
              'collecting_identity','verifying_identity','context_unlocked',
              'failed','escalated')
          ),
          CONSTRAINT ck_voice_identity_attempts CHECK (
            attempts BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 10
          ),
          CONSTRAINT ck_voice_identity_failure_policy CHECK (
            on_failure IN ('human_handoff','end_call')
          ),
          CONSTRAINT ck_voice_identity_disclosure CHECK (
            context_disclosure='after_verification'
          ),
          CONSTRAINT ck_voice_identity_timestamps CHECK (
            (state='context_unlocked'
              AND verified_at IS NOT NULL AND context_unlocked_at IS NOT NULL)
            OR (state<>'context_unlocked'
              AND verified_at IS NULL AND context_unlocked_at IS NULL)
          )
        )
        """
    )
    op.execute(
        """
        CREATE INDEX ix_voice_identity_handoff_state
        ON automation.voice_identity_verifications(
          tenant_id, handoff_id, state, updated_at DESC
        )
        """
    )
    op.execute("ALTER TABLE automation.voice_identity_verifications ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE automation.voice_identity_verifications FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY tenant_isolation_voice_identity_verifications
        ON automation.voice_identity_verifications
        USING (tenant_id=platform.current_tenant_id())
        WITH CHECK (tenant_id=platform.current_tenant_id())
        """
    )

    op.execute(
        """
        CREATE FUNCTION platform.normalize_identity_name(value text)
        RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
        SET search_path=pg_catalog AS $$
          SELECT lower(regexp_replace(
            normalize(btrim(coalesce(value,'')), NFKC),
            '[[:space:][:punct:]]+', '', 'g'
          ))
        $$
        """
    )

    # The voice role does not receive direct access to public.tenants. Expose
    # only the active current tenant's prompt configuration through a narrow,
    # tenant-bound projection.
    op.execute(
        """
        CREATE FUNCTION platform.current_voice_tenant_support_profile()
        RETURNS jsonb
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path=pg_catalog AS $$
          SELECT jsonb_build_object(
            'tenantName',tenant.name,
            'displayName',settings.display_name,
            'businessName',settings.business_name,
            'locale',coalesce(settings.locale,'en'),
            'timezone',coalesce(settings.timezone,'UTC'),
            'supportProfile',coalesce(
              settings.support_profile,'{"schemaVersion":"1.0"}'::jsonb
            )
          )
          FROM public.tenants tenant
          LEFT JOIN crm.tenant_settings settings ON settings.tenant_id=tenant.id
          WHERE tenant.id=platform.current_tenant_id()
            AND tenant.status='active'
          LIMIT 1
        $$
        """
    )

    initialization_sql = f"""
        CREATE FUNCTION platform.initialize_voice_identity_verification(
          p_session_id uuid, p_handoff_id uuid
        ) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path=pg_catalog,public,crm,messaging,automation,platform
        AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_contact uuid;
          v_conversation uuid;
          v_policy jsonb;
          v_factors text[];
          v_enabled boolean;
          v_max_attempts integer;
          v_on_failure text;
          v_state text;
          v_available boolean;
          v_record automation.voice_identity_verifications%ROWTYPE;
        BEGIN
          SELECT handoff.contact_id, handoff.conversation_id
          INTO v_contact, v_conversation
          FROM public.sessions session
          JOIN automation.handoffs handoff
            ON handoff.tenant_id=session.tenant_id
           AND handoff.id=p_handoff_id
          JOIN messaging.conversations conversation
            ON conversation.tenant_id=handoff.tenant_id
           AND conversation.id=handoff.conversation_id
           AND conversation.contact_id=handoff.contact_id
          WHERE session.tenant_id=v_tenant
            AND session.session_id=p_session_id
            AND session.contact_id=handoff.contact_id
            AND handoff.source_channel='whatsapp'
            AND handoff.status IN ('pending','accepted')
            AND (handoff.session_id IS NULL OR handoff.session_id=p_session_id);
          IF v_contact IS NULL OR v_conversation IS NULL THEN
            RAISE EXCEPTION 'voice handoff binding is unavailable'
              USING ERRCODE='42501';
          END IF;

          SELECT coalesce(settings.identity_verification_policy, {_DEFAULT_POLICY})
          INTO v_policy
          FROM crm.tenant_settings settings
          WHERE settings.tenant_id=v_tenant;
          v_policy := coalesce(v_policy, {_DEFAULT_POLICY});
          v_enabled := (v_policy->>'enabled')::boolean;
          v_max_attempts := (v_policy->>'maxAttempts')::integer;
          v_on_failure := v_policy->>'onFailure';
          SELECT array_agg(factor ORDER BY ordinal)
          INTO v_factors
          FROM jsonb_array_elements_text(v_policy->'requiredFactors')
            WITH ORDINALITY AS configured(factor, ordinal);

          SELECT NOT EXISTS (
            SELECT 1 FROM unnest(v_factors) factor
            WHERE CASE factor
              WHEN 'fullName' THEN NOT EXISTS (
                SELECT 1 FROM crm.contacts contact
                WHERE contact.tenant_id=v_tenant AND contact.id=v_contact
                  AND nullif(btrim(contact.name),'') IS NOT NULL
              )
              WHEN 'phone' THEN NOT EXISTS (
                SELECT 1 FROM crm.contact_channel_identities identity
                WHERE identity.tenant_id=v_tenant AND identity.contact_id=v_contact
                  AND identity.channel IN ('phone','whatsapp')
                  AND identity.validation_status='valid'
                  AND identity.normalized_value ~ '^\\+[1-9][0-9]{{7,14}}$'
              )
              WHEN 'nationalId' THEN NOT EXISTS (
                SELECT 1 FROM crm.customer_profiles profile
                WHERE profile.tenant_id=v_tenant AND profile.contact_id=v_contact
                  AND profile.national_id_blind_index IS NOT NULL
              )
              WHEN 'customerNumber' THEN NOT EXISTS (
                SELECT 1 FROM crm.customer_profiles profile
                WHERE profile.tenant_id=v_tenant AND profile.contact_id=v_contact
                  AND nullif(btrim(profile.details->>'customerNumber'),'') IS NOT NULL
              )
              ELSE true
            END
          ) INTO v_available;

          v_state := CASE
            WHEN NOT v_enabled THEN 'context_unlocked'
            WHEN NOT v_available THEN 'escalated'
            ELSE 'identity_required'
          END;
          INSERT INTO automation.voice_identity_verifications(
            tenant_id,session_id,handoff_id,contact_id,conversation_id,
            required_factors,state,max_attempts,on_failure,context_disclosure,
            verified_at,context_unlocked_at
          ) VALUES (
            v_tenant,p_session_id,p_handoff_id,v_contact,v_conversation,
            v_factors,v_state,v_max_attempts,v_on_failure,
            v_policy->>'contextDisclosure',
            CASE WHEN v_state='context_unlocked' THEN clock_timestamp() END,
            CASE WHEN v_state='context_unlocked' THEN clock_timestamp() END
          ) ON CONFLICT (tenant_id,session_id) DO NOTHING;

          SELECT * INTO v_record
          FROM automation.voice_identity_verifications verification
          WHERE verification.tenant_id=v_tenant
            AND verification.session_id=p_session_id
            AND verification.handoff_id=p_handoff_id
            AND verification.contact_id=v_contact
            AND verification.conversation_id=v_conversation;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'voice verification binding conflicts with existing session'
              USING ERRCODE='23505';
          END IF;

          UPDATE automation.handoffs
          SET session_id=p_session_id,
              status=CASE WHEN v_record.state='escalated' THEN 'pending' ELSE 'accepted' END,
              accepted_at=CASE WHEN v_record.state='escalated'
                THEN NULL ELSE coalesce(accepted_at,clock_timestamp()) END,
              updated_at=clock_timestamp()
          WHERE tenant_id=v_tenant AND id=p_handoff_id;

          RETURN jsonb_build_object(
            'required', v_record.state<>'context_unlocked',
            'factors', to_jsonb(v_record.required_factors),
            'state', v_record.state,
            'maxAttempts', v_record.max_attempts,
            'remainingAttempts', v_record.max_attempts-v_record.attempts,
            'onFailure', v_record.on_failure
          );
        END
        $$
        """  # noqa: S608 -- interpolation is a module-owned JSON SQL literal.
    op.execute(initialization_sql)

    op.execute(
        """
        CREATE FUNCTION platform.voice_identity_verification_requirements(
          p_session_id uuid
        ) RETURNS jsonb
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path=pg_catalog,automation,platform AS $$
          SELECT jsonb_build_object(
            'required', verification.state<>'context_unlocked',
            'factors', to_jsonb(verification.required_factors),
            'state', verification.state,
            'maxAttempts', verification.max_attempts,
            'remainingAttempts', verification.max_attempts-verification.attempts,
            'onFailure', verification.on_failure
          )
          FROM automation.voice_identity_verifications verification
          WHERE verification.tenant_id=platform.current_tenant_id()
            AND verification.session_id=p_session_id
        $$
        """
    )

    op.execute(
        """
        CREATE FUNCTION platform.verify_voice_caller_identity(
          p_session_id uuid,
          p_full_name text DEFAULT NULL,
          p_phone_e164 text DEFAULT NULL,
          p_national_id_blind_index text DEFAULT NULL,
          p_customer_number text DEFAULT NULL
        ) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER
        SET search_path=pg_catalog,public,crm,automation,platform AS $$
        DECLARE
          v_tenant uuid := platform.current_tenant_id();
          v_record automation.voice_identity_verifications%ROWTYPE;
          v_matches boolean;
          v_attempts integer;
          v_state text;
        BEGIN
          SELECT * INTO v_record
          FROM automation.voice_identity_verifications verification
          WHERE verification.tenant_id=v_tenant
            AND verification.session_id=p_session_id
          FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'voice verification is unavailable' USING ERRCODE='42501';
          END IF;
          IF v_record.state='context_unlocked' THEN
            RETURN jsonb_build_object(
              'verified',true,'state','context_unlocked','remainingAttempts',
              v_record.max_attempts-v_record.attempts
            );
          END IF;
          IF v_record.state NOT IN ('identity_required','collecting_identity') THEN
            RETURN jsonb_build_object(
              'verified',false,'state',v_record.state,'remainingAttempts',0
            );
          END IF;

          UPDATE automation.voice_identity_verifications
          SET state='verifying_identity',updated_at=clock_timestamp()
          WHERE tenant_id=v_tenant AND session_id=p_session_id;

          SELECT bool_and(CASE factor
            WHEN 'fullName' THEN
              platform.normalize_identity_name(contact.name)=p_full_name
            WHEN 'phone' THEN EXISTS (
              SELECT 1 FROM crm.contact_channel_identities identity
              WHERE identity.tenant_id=v_tenant
                AND identity.contact_id=v_record.contact_id
                AND identity.channel IN ('phone','whatsapp')
                AND identity.validation_status='valid'
                AND identity.normalized_value=p_phone_e164
            )
            WHEN 'nationalId' THEN EXISTS (
              SELECT 1 FROM crm.customer_profiles profile
              WHERE profile.tenant_id=v_tenant
                AND profile.contact_id=v_record.contact_id
                AND profile.national_id_blind_index=p_national_id_blind_index
            )
            WHEN 'customerNumber' THEN EXISTS (
              SELECT 1 FROM crm.customer_profiles profile
              WHERE profile.tenant_id=v_tenant
                AND profile.contact_id=v_record.contact_id
                AND btrim(profile.details->>'customerNumber')=p_customer_number
            )
            ELSE false END)
          INTO v_matches
          FROM unnest(v_record.required_factors) factor
          CROSS JOIN crm.contacts contact
          WHERE contact.tenant_id=v_tenant AND contact.id=v_record.contact_id;

          v_attempts := v_record.attempts+1;
          IF coalesce(v_matches,false) THEN
            UPDATE automation.voice_identity_verifications
            SET state='context_unlocked',attempts=v_attempts,
                verified_at=clock_timestamp(),context_unlocked_at=clock_timestamp(),
                updated_at=clock_timestamp()
            WHERE tenant_id=v_tenant AND session_id=p_session_id;
            RETURN jsonb_build_object(
              'verified',true,'state','context_unlocked',
              'remainingAttempts',v_record.max_attempts-v_attempts
            );
          END IF;

          v_state := CASE
            WHEN v_attempts < v_record.max_attempts THEN 'collecting_identity'
            WHEN v_record.on_failure='human_handoff' THEN 'escalated'
            ELSE 'failed'
          END;
          UPDATE automation.voice_identity_verifications
          SET state=v_state,attempts=v_attempts,updated_at=clock_timestamp()
          WHERE tenant_id=v_tenant AND session_id=p_session_id;
          IF v_state='escalated' THEN
            UPDATE automation.handoffs
            SET status='pending',assigned_user_id=NULL,accepted_at=NULL,
                reason_safe='Caller identity verification requires human follow-up.',
                updated_at=clock_timestamp()
            WHERE tenant_id=v_tenant AND id=v_record.handoff_id;
          END IF;
          RETURN jsonb_build_object(
            'verified',false,'state',v_state,
            'remainingAttempts',greatest(v_record.max_attempts-v_attempts,0)
          );
        END
        $$
        """
    )

    # This is the only voice-runtime read that can obtain prior customer data.
    # It re-establishes every tenant/contact/conversation binding and refuses
    # access unless the authoritative verification row is unlocked.
    op.execute(
        """
        CREATE FUNCTION platform.verified_voice_handoff_context(p_session_id uuid)
        RETURNS jsonb
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path=pg_catalog,public,crm,messaging,automation,service,platform
        AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id(); v_result jsonb;
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM automation.voice_identity_verifications verification
            JOIN automation.handoffs handoff
              ON handoff.tenant_id=verification.tenant_id
             AND handoff.id=verification.handoff_id
             AND handoff.session_id=verification.session_id
             AND handoff.contact_id=verification.contact_id
             AND handoff.conversation_id=verification.conversation_id
            WHERE verification.tenant_id=v_tenant
              AND verification.session_id=p_session_id
              AND verification.state='context_unlocked'
          ) THEN
            RAISE EXCEPTION 'verified handoff context is locked' USING ERRCODE='42501';
          END IF;

          WITH binding AS (
            SELECT verification.contact_id,verification.conversation_id,
                   verification.handoff_id
            FROM automation.voice_identity_verifications verification
            WHERE verification.tenant_id=v_tenant
              AND verification.session_id=p_session_id
              AND verification.state='context_unlocked'
          ), case_candidates AS (
            SELECT DISTINCT service_case.*
            FROM binding
            JOIN service.case_conversations link
              ON link.tenant_id=v_tenant
             AND link.conversation_id=binding.conversation_id
            JOIN service.cases service_case
              ON service_case.tenant_id=link.tenant_id
             AND service_case.id=link.case_id
             AND service_case.customer_contact_id=binding.contact_id
             AND service_case.status NOT IN ('closed','cancelled')
          ), active_case AS (
            SELECT candidate.* FROM case_candidates candidate
            WHERE (SELECT count(*) FROM case_candidates)=1
          )
          SELECT jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion','1.0',
            'handoffId',binding.handoff_id,
            'contact',jsonb_build_object(
              'id',contact.id,'fullName',contact.name,
              'preferredLanguage',profile.preferred_language
            ),
            'sourceConversation',jsonb_build_object(
              'id',conversation.id,'status',conversation.status
            ),
            'issueSummary',coalesce(active_case.fault_description,
              conversation.last_message_preview),
            'relevantMessages',coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'direction',selected.direction,'text',selected.content_text,
                'createdAt',selected.created_at
              ) ORDER BY selected.created_at,selected.id)
              FROM (
                SELECT message.id,message.direction,message.content_text,message.created_at
                FROM messaging.messages message
                WHERE message.tenant_id=v_tenant
                  AND message.conversation_id=binding.conversation_id
                  AND message.content_type='text'
                  AND message.content_text IS NOT NULL
                  AND ((message.direction='inbound' AND message.status='received')
                    OR (message.direction='outbound'
                      AND message.status IN ('sent','delivered','read')))
                ORDER BY message.created_at DESC,message.id DESC LIMIT 12
              ) selected
            ),'[]'::jsonb),
            'activeCase',CASE WHEN active_case.id IS NULL THEN NULL ELSE
              jsonb_build_object(
                'id',active_case.id,'reference',active_case.reference,
                'status',active_case.status,'title',active_case.title,
                'issue',active_case.fault_description,
                'priority',active_case.priority,'productType',active_case.product_type,
                'productModel',active_case.product_model,
                'serialNumber',active_case.serial_number,
                'warrantyStatus',active_case.warranty_status
              ) END,
            'location',CASE WHEN location.id IS NULL THEN NULL ELSE
              jsonb_build_object('id',location.id,'name',location.name,
                'address',location.address) END,
            'appointments',coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id',appointment.id,'status',appointment.status,
                'startsAt',appointment.starts_at,'endsAt',appointment.ends_at,
                'timezone',appointment.timezone,'technician',technician.full_name
              ) ORDER BY appointment.starts_at)
              FROM (
                SELECT candidate.* FROM service.appointments candidate
                WHERE candidate.tenant_id=v_tenant
                  AND candidate.case_id=active_case.id
                  AND candidate.status<>'cancelled'
                ORDER BY candidate.starts_at,candidate.id LIMIT 3
              ) appointment
              JOIN service.technicians technician
                ON technician.tenant_id=appointment.tenant_id
               AND technician.id=appointment.technician_id
            ),'[]'::jsonb),
            'relevantPreviousVisits',coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id',visit.id,'visitNumber',visit.visit_number,
                'status',visit.status,'technician',technician.full_name,
                'arrivedAt',visit.arrival_at,'departedAt',visit.departure_at
              ) ORDER BY visit.visit_number DESC)
              FROM (
                SELECT candidate.* FROM service.visits candidate
                WHERE candidate.tenant_id=v_tenant
                  AND candidate.case_id=active_case.id
                ORDER BY candidate.visit_number DESC,candidate.id LIMIT 3
              ) visit
              JOIN service.technicians technician
                ON technician.tenant_id=visit.tenant_id
               AND technician.id=visit.technician_id
            ),'[]'::jsonb),
            'relevantTechnicianReports',coalesce((
              SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'reportId',report.id,'visitId',report.visit_id,
                'diagnosis',revision.diagnosis,
                'workPerformed',revision.work_performed
              )) ORDER BY revision.created_at DESC)
              FROM (
                SELECT candidate.* FROM service.reports candidate
                WHERE candidate.tenant_id=v_tenant
                  AND candidate.case_id=active_case.id
                  AND candidate.deleted_at IS NULL
                ORDER BY candidate.created_at DESC,candidate.id LIMIT 3
              ) report
              JOIN service.report_revisions revision
                ON revision.tenant_id=report.tenant_id
               AND revision.report_id=report.id
               AND revision.status='finalized'
            ),'[]'::jsonb)
          )) INTO v_result
          FROM binding
          JOIN crm.contacts contact
            ON contact.tenant_id=v_tenant AND contact.id=binding.contact_id
          JOIN messaging.conversations conversation
            ON conversation.tenant_id=v_tenant
           AND conversation.id=binding.conversation_id
           AND conversation.contact_id=binding.contact_id
          LEFT JOIN crm.customer_profiles profile
            ON profile.tenant_id=v_tenant AND profile.contact_id=contact.id
          LEFT JOIN active_case ON true
          LEFT JOIN crm.service_locations location
            ON location.tenant_id=v_tenant
           AND location.id=active_case.service_location_id;
          IF v_result IS NULL THEN
            RAISE EXCEPTION 'verified handoff context is unavailable' USING ERRCODE='42501';
          END IF;
          RETURN v_result;
        END
        $$
        """
    )

    # Build the safe CRM/timeline projection as the schema owner. The runtime
    # never receives SELECT on the raw verification table or broad service data.
    op.execute(
        """
        CREATE FUNCTION platform.write_voice_session_outcome(p_session_id uuid)
        RETURNS boolean
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path=pg_catalog,public,automation,service,platform AS $$
        DECLARE v_tenant uuid := platform.current_tenant_id(); v_updated boolean;
        BEGIN
          WITH binding AS (
            SELECT verification.handoff_id,verification.conversation_id,
                   verification.contact_id,verification.state
            FROM automation.voice_identity_verifications verification
            WHERE verification.tenant_id=v_tenant
              AND verification.session_id=p_session_id
          ), case_candidates AS (
            SELECT DISTINCT service_case.id,service_case.title,
                   service_case.fault_description,service_case.status
            FROM binding
            JOIN service.case_conversations link
              ON link.tenant_id=v_tenant
             AND link.conversation_id=binding.conversation_id
            JOIN service.cases service_case
              ON service_case.tenant_id=link.tenant_id
             AND service_case.id=link.case_id
             AND service_case.customer_contact_id=binding.contact_id
             AND service_case.status NOT IN ('closed','cancelled')
          ), linked_case AS (
            SELECT candidate.* FROM case_candidates candidate
            WHERE (SELECT count(*) FROM case_candidates)=1
          )
          UPDATE public.sessions session
          SET outcome_detail=jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion','1.0',
            'contactId',session.contact_id,
            'conversationId',(SELECT conversation_id FROM binding),
            'caseId',(SELECT id FROM linked_case),
            'handoffId',(SELECT handoff_id FROM binding),
            'status',session.status,
            'summary',CASE WHEN session.outcome IS NULL
              THEN 'Voice interaction ended before a terminal flow outcome.'
              ELSE 'Voice interaction completed with a recorded flow outcome.' END,
            'issue',coalesce(
              (SELECT title FROM linked_case),
              (SELECT fault_description FROM linked_case)
            ),
            'resolution',session.outcome,
            'unresolvedItems',CASE WHEN session.outcome IS NULL
              THEN jsonb_build_array('terminal_outcome_not_reached')
              ELSE '[]'::jsonb END,
            'nextAction',(SELECT status FROM linked_case),
            'escalation',CASE WHEN (SELECT state FROM binding)='escalated'
              THEN 'human_handoff' END,
            'technicianRequired',CASE
              WHEN (SELECT id FROM linked_case) IS NULL THEN NULL
              ELSE EXISTS (
                SELECT 1 FROM service.appointments appointment
                WHERE appointment.tenant_id=v_tenant
                  AND appointment.case_id=(SELECT id FROM linked_case)
                  AND appointment.status<>'cancelled'
                UNION ALL
                SELECT 1 FROM service.visits visit
                WHERE visit.tenant_id=v_tenant
                  AND visit.case_id=(SELECT id FROM linked_case)
                  AND visit.status<>'cancelled'
              ) END,
            'startedAt',session.created_at,
            'endedAt',session.ended_at
          ))
          WHERE session.tenant_id=v_tenant AND session.session_id=p_session_id
          RETURNING true INTO v_updated;

          UPDATE automation.handoffs handoff
          SET status='resolved',resolved_at=coalesce(
                handoff.resolved_at,clock_timestamp()
              ),updated_at=clock_timestamp()
          FROM automation.voice_identity_verifications verification,
               public.sessions session
          WHERE verification.tenant_id=v_tenant
            AND verification.session_id=p_session_id
            AND verification.state='context_unlocked'
            AND session.tenant_id=verification.tenant_id
            AND session.session_id=verification.session_id
            AND session.status='ended'
            AND handoff.tenant_id=verification.tenant_id
            AND handoff.id=verification.handoff_id
            AND handoff.session_id=verification.session_id
            AND handoff.status='accepted';
          RETURN coalesce(v_updated,false);
        END
        $$
        """
    )

    for statement in (
        "REVOKE ALL ON FUNCTION platform.normalize_identity_name(text) FROM PUBLIC",
        "REVOKE ALL ON FUNCTION platform.current_voice_tenant_support_profile() FROM PUBLIC",
        "REVOKE ALL ON FUNCTION "
        "platform.initialize_voice_identity_verification(uuid,uuid) FROM PUBLIC",
        "REVOKE ALL ON FUNCTION "
        "platform.voice_identity_verification_requirements(uuid) FROM PUBLIC",
        "REVOKE ALL ON FUNCTION platform.verify_voice_caller_identity("
        "uuid,text,text,text,text) FROM PUBLIC",
        "REVOKE ALL ON FUNCTION platform.verified_voice_handoff_context(uuid) FROM PUBLIC",
        "REVOKE ALL ON FUNCTION platform.write_voice_session_outcome(uuid) FROM PUBLIC",
        "GRANT EXECUTE ON FUNCTION platform.normalize_identity_name(text) TO platform_voice",
        "GRANT EXECUTE ON FUNCTION platform.current_voice_tenant_support_profile() "
        "TO platform_voice",
        "GRANT EXECUTE ON FUNCTION "
        "platform.initialize_voice_identity_verification(uuid,uuid) TO platform_voice",
        "GRANT EXECUTE ON FUNCTION "
        "platform.voice_identity_verification_requirements(uuid) TO platform_voice",
        "GRANT EXECUTE ON FUNCTION platform.verify_voice_caller_identity("
        "uuid,text,text,text,text) TO platform_voice",
        "GRANT EXECUTE ON FUNCTION platform.verified_voice_handoff_context(uuid) TO platform_voice",
        "GRANT EXECUTE ON FUNCTION platform.write_voice_session_outcome(uuid) TO platform_voice",
        "GRANT SELECT (tenant_id,session_id,contact_id,status,outcome,outcome_detail,"
        "answered,created_at,ended_at) ON public.sessions "
        "TO platform_web,platform_readonly",
    ):
        op.execute(statement)

    op.execute(
        """
        CREATE OR REPLACE VIEW platform.contact_activity
        WITH (security_invoker=true) AS
        SELECT m.tenant_id,m.id AS event_id,c.contact_id,'message'::text AS source_type,
               ('message.'||m.direction::text||'.'||m.status::text) AS event_type,
               m.created_at AS occurred_at,
               jsonb_build_object('conversation_id',m.conversation_id,
                 'content_type',m.content_type,'direction',m.direction,'status',m.status)
                 AS metadata
        FROM messaging.messages m JOIN messaging.conversations c
          ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id
        UNION ALL
        SELECT s.tenant_id,s.session_id,s.contact_id,'voice',
               ('voice.call.'||s.status::text),s.created_at,
               jsonb_strip_nulls(jsonb_build_object(
                 'status',s.status,'outcome',s.outcome,'answered',s.answered,
                 'detail',s.outcome_detail
               ))
        FROM public.sessions s WHERE s.contact_id IS NOT NULL
        UNION ALL
        SELECT d.tenant_id,d.id,d.contact_id,'deal',('crm.deal.'||d.status::text),
               d.updated_at,jsonb_build_object('status',d.status,'stage_id',d.stage_id,
                 'currency',d.currency)
        FROM crm.deals d WHERE d.contact_id IS NOT NULL
        UNION ALL
        SELECT r.tenant_id,r.id,r.contact_id,'automation',
               ('automation.run.'||r.status::text),r.created_at,
               jsonb_build_object('status',r.status,'trigger_type',r.trigger_type,
                 'flow_version_id',r.flow_version_id)
        FROM automation.flow_runs r WHERE r.contact_id IS NOT NULL
        UNION ALL
        SELECT recipient.tenant_id,recipient.id,recipient.contact_id,'campaign',
               ('campaign.messaging.'||recipient.status::text),
               coalesce(recipient.replied_at,recipient.read_at,recipient.delivered_at,
                        recipient.sent_at,recipient.created_at),
               jsonb_build_object('broadcast_id',recipient.broadcast_id,
                 'status',recipient.status,'attempts',recipient.attempts)
        FROM messaging.broadcast_recipients recipient
        UNION ALL
        SELECT h.tenant_id,h.id,h.contact_id,'handoff',
               ('handoff.'||h.status::text),h.requested_at,
               jsonb_build_object('status',h.status,'source_channel',h.source_channel,
                 'assigned_user_id',h.assigned_user_id,'conversation_id',h.conversation_id,
                 'session_id',h.session_id)
        FROM automation.handoffs h
        """
    )


def downgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE VIEW platform.contact_activity
        WITH (security_invoker=true) AS
        SELECT m.tenant_id,m.id AS event_id,c.contact_id,'message'::text AS source_type,
               ('message.'||m.direction::text||'.'||m.status::text) AS event_type,
               m.created_at AS occurred_at,
               jsonb_build_object('conversation_id',m.conversation_id,
                 'content_type',m.content_type,'direction',m.direction,'status',m.status)
                 AS metadata
        FROM messaging.messages m JOIN messaging.conversations c
          ON c.tenant_id=m.tenant_id AND c.id=m.conversation_id
        UNION ALL
        SELECT s.tenant_id,s.session_id,s.contact_id,'voice',
               ('voice.call.'||s.status::text),s.created_at,
               jsonb_build_object('status',s.status,'outcome',s.outcome,'answered',s.answered)
        FROM public.sessions s WHERE s.contact_id IS NOT NULL
        UNION ALL
        SELECT d.tenant_id,d.id,d.contact_id,'deal',('crm.deal.'||d.status::text),
               d.updated_at,jsonb_build_object('status',d.status,'stage_id',d.stage_id,
                 'currency',d.currency)
        FROM crm.deals d WHERE d.contact_id IS NOT NULL
        UNION ALL
        SELECT r.tenant_id,r.id,r.contact_id,'automation',
               ('automation.run.'||r.status::text),r.created_at,
               jsonb_build_object('status',r.status,'trigger_type',r.trigger_type,
                 'flow_version_id',r.flow_version_id)
        FROM automation.flow_runs r WHERE r.contact_id IS NOT NULL
        UNION ALL
        SELECT recipient.tenant_id,recipient.id,recipient.contact_id,'campaign',
               ('campaign.messaging.'||recipient.status::text),
               coalesce(recipient.replied_at,recipient.read_at,recipient.delivered_at,
                        recipient.sent_at,recipient.created_at),
               jsonb_build_object('broadcast_id',recipient.broadcast_id,
                 'status',recipient.status,'attempts',recipient.attempts)
        FROM messaging.broadcast_recipients recipient
        UNION ALL
        SELECT h.tenant_id,h.id,h.contact_id,'handoff',
               ('handoff.'||h.status::text),h.requested_at,
               jsonb_build_object('status',h.status,'source_channel',h.source_channel,
                 'assigned_user_id',h.assigned_user_id)
        FROM automation.handoffs h
        """
    )
    for statement in (
        "DROP FUNCTION platform.verified_voice_handoff_context(uuid)",
        "DROP FUNCTION platform.write_voice_session_outcome(uuid)",
        "DROP FUNCTION platform.verify_voice_caller_identity(uuid,text,text,text,text)",
        "DROP FUNCTION platform.voice_identity_verification_requirements(uuid)",
        "DROP FUNCTION platform.initialize_voice_identity_verification(uuid,uuid)",
        "DROP FUNCTION platform.current_voice_tenant_support_profile()",
        "DROP FUNCTION platform.normalize_identity_name(text)",
        "DROP TABLE automation.voice_identity_verifications",
        "ALTER TABLE public.sessions DROP CONSTRAINT ck_sessions_outcome_detail_object",
        "ALTER TABLE public.sessions DROP COLUMN outcome_detail",
        """
        ALTER TABLE crm.tenant_settings
          DROP CONSTRAINT ck_tenant_identity_verification_policy,
          DROP CONSTRAINT ck_tenant_support_profile_shape,
          DROP COLUMN identity_verification_policy,
          DROP COLUMN support_profile
        """,
    ):
        op.execute(statement)
