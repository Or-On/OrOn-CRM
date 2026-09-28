"""Bound SMS verification for staff sign-in and customer calls.

Revision ID: 9b2e7a4c6d18
Revises: 8d4a6c2e9b10
"""

# ruff: noqa: E501, S608 -- migration-owned SQL constants only.
from alembic import op

revision = "9b2e7a4c6d18"
down_revision = "8d4a6c2e9b10"
branch_labels = None
depends_on = None


def _execute(sql: str) -> None:
    """Split migration-owned statements without splitting dollar-quoted bodies."""
    pending = ""
    for index, part in enumerate(sql.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
        else:
            statements = part.split(";")
            pending += statements[0]
            for statement in statements[1:]:
                if pending.strip():
                    op.execute(pending.replace(":", r"\:"))
                pending = statement
    if pending.strip():
        op.execute(pending.replace(":", r"\:"))


def _function(sql: str, signature: str, roles: str = "") -> None:
    _execute(sql)
    op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
    if roles:
        op.execute(f"GRANT EXECUTE ON FUNCTION {signature} TO {roles}")


def upgrade() -> None:
    _execute("""
      CREATE TABLE platform.staff_sms_credentials (
        user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
        phone_e164 text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
        verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE platform.sms_otp_challenges (
        id uuid PRIMARY KEY,
        purpose text NOT NULL CHECK (purpose IN ('staff_enrollment','staff_login','staff_disable','voice_identity')),
        user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
        auth_session_id uuid REFERENCES platform.auth_sessions(id) ON DELETE CASCADE,
        tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
        voice_session_id uuid,
        contact_id uuid,
        phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
        code_digest text NOT NULL CHECK (code_digest ~ '^[0-9a-f]{64}$'),
        password_snapshot text,
        state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','pending','consumed','failed','superseded')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
        created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '5 minutes',
        consumed_at timestamptz,
        FOREIGN KEY (tenant_id,voice_session_id) REFERENCES public.sessions(tenant_id,session_id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id,contact_id) REFERENCES crm.contacts(tenant_id,id) ON DELETE CASCADE,
        CHECK ((purpose='voice_identity' AND user_id IS NULL AND tenant_id IS NOT NULL AND voice_session_id IS NOT NULL AND contact_id IS NOT NULL)
          OR (purpose<>'voice_identity' AND user_id IS NOT NULL AND voice_session_id IS NULL)),
        CHECK (expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
      );
      CREATE INDEX ix_sms_otp_user_recent ON platform.sms_otp_challenges(user_id,created_at DESC);
      CREATE INDEX ix_sms_otp_voice_recent ON platform.sms_otp_challenges(tenant_id,voice_session_id,created_at DESC);
      CREATE INDEX ix_sms_otp_phone_recent ON platform.sms_otp_challenges(phone_e164,created_at DESC);
      ALTER TABLE platform.staff_sms_credentials ENABLE ROW LEVEL SECURITY;
      ALTER TABLE platform.staff_sms_credentials FORCE ROW LEVEL SECURITY;
      ALTER TABLE platform.sms_otp_challenges ENABLE ROW LEVEL SECURITY;
      ALTER TABLE platform.sms_otp_challenges FORCE ROW LEVEL SECURITY;
      -- No table grants or permissive policies: only the narrow definer functions below.
      ALTER TABLE automation.voice_identity_verifications
        ALTER COLUMN handoff_id DROP NOT NULL, ALTER COLUMN conversation_id DROP NOT NULL,
        ADD COLUMN sms_required boolean NOT NULL DEFAULT false,
        ADD COLUMN sms_verified_at timestamptz,
        DROP CONSTRAINT ck_voice_identity_factors,
        ADD CONSTRAINT ck_voice_identity_factors CHECK (
          cardinality(required_factors) BETWEEN 0 AND 4
          AND (cardinality(required_factors)>0 OR sms_required)
          AND required_factors <@ ARRAY['fullName','phone','nationalId','customerNumber']::text[]),
        ADD CONSTRAINT ck_voice_identity_sms_binding CHECK ((handoff_id IS NULL)=(conversation_id IS NULL));
      ALTER TABLE crm.tenant_settings ADD CONSTRAINT ck_identity_sms_option CHECK (
        NOT (identity_verification_policy ? 'smsOtp') OR jsonb_typeof(identity_verification_policy->'smsOtp')='boolean');
    """)
    _function(
        """
      CREATE FUNCTION platform.auth_sms_phone(p_user uuid) RETURNS text
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT phone_e164 FROM platform.staff_sms_credentials WHERE user_id=p_user
      $$
    """,
        "platform.auth_sms_phone(uuid)",
        "platform_web",
    )
    _function(
        """
      CREATE FUNCTION platform.sms_reserve(p_id uuid,p_purpose text,p_user uuid,p_auth_session uuid,
        p_tenant uuid,p_voice uuid,p_contact uuid,p_phone text,p_digest text) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        -- Serialize the rolling quota across sessions and purposes for a destination.
        PERFORM pg_advisory_xact_lock(hashtextextended('sms:'||p_phone,0));
        IF p_user IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('sms-user:'||p_user::text,0)); END IF;
        IF EXISTS(SELECT 1 FROM platform.sms_otp_challenges WHERE phone_e164=p_phone
          AND created_at>clock_timestamp()-interval '60 seconds')
          OR (SELECT count(*) FROM platform.sms_otp_challenges WHERE phone_e164=p_phone
            AND created_at>clock_timestamp()-interval '1 hour')>=5
          OR (p_user IS NOT NULL AND (SELECT count(*) FROM platform.sms_otp_challenges WHERE user_id=p_user
            AND created_at>clock_timestamp()-interval '1 hour')>=5) THEN
          RAISE EXCEPTION 'SMS verification rate limited' USING ERRCODE='P0001'; END IF;
        UPDATE platform.sms_otp_challenges SET state='superseded'
          WHERE state IN ('reserved','pending') AND purpose=p_purpose
          AND ((p_user IS NOT NULL AND user_id=p_user) OR
            (p_voice IS NOT NULL AND tenant_id=p_tenant AND voice_session_id=p_voice));
        INSERT INTO platform.sms_otp_challenges(id,purpose,user_id,auth_session_id,tenant_id,voice_session_id,contact_id,
          phone_e164,code_digest,password_snapshot)
        VALUES(p_id,p_purpose,p_user,p_auth_session,p_tenant,p_voice,p_contact,p_phone,p_digest,
          (SELECT password_hash FROM platform.auth_credentials WHERE user_id=p_user));
      END $$
    """,
        "platform.sms_reserve(uuid,text,uuid,uuid,uuid,uuid,uuid,text,text)",
    )
    _function(
        """
      CREATE FUNCTION platform.auth_start_sms(p_id uuid,p_purpose text,p_user uuid,p_session uuid,p_phone text,p_digest text)
      RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_phone text; v_tenant uuid;
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.users u JOIN platform.auth_credentials c ON c.user_id=u.id
          WHERE u.id=p_user AND u.status='active' AND (c.locked_until IS NULL OR c.locked_until<=clock_timestamp())) THEN
          RAISE EXCEPTION 'SMS verification unavailable' USING ERRCODE='42501'; END IF;
        IF p_purpose NOT IN ('staff_login','staff_enrollment','staff_disable') THEN
          RAISE EXCEPTION 'invalid verification purpose' USING ERRCODE='22023'; END IF;
        IF p_purpose<>'staff_login' AND NOT EXISTS(SELECT 1 FROM platform.auth_sessions s
          WHERE s.id=p_session AND s.user_id=p_user AND s.revoked_at IS NULL
          AND s.idle_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp()) THEN
          RAISE EXCEPTION 'active authentication required' USING ERRCODE='42501'; END IF;
        v_phone:=platform.auth_sms_phone(p_user);
        IF p_purpose='staff_enrollment' THEN
          IF v_phone IS NOT NULL OR p_phone IS NULL OR p_phone !~ '^\\+[1-9][0-9]{7,14}$' THEN
            RAISE EXCEPTION 'SMS enrollment unavailable' USING ERRCODE='22023'; END IF;
          v_phone:=p_phone;
        END IF;
        IF v_phone IS NULL THEN RAISE EXCEPTION 'SMS verification unavailable' USING ERRCODE='42501'; END IF;
        IF p_purpose='staff_login' THEN
          SELECT tenant_id INTO v_tenant FROM platform.auth_memberships_for_user(p_user) LIMIT 1;
        ELSE SELECT active_tenant_id INTO v_tenant FROM platform.auth_sessions WHERE id=p_session AND user_id=p_user;
        END IF;
        IF v_tenant IS NULL THEN RAISE EXCEPTION 'active membership required' USING ERRCODE='42501'; END IF;
        PERFORM platform.sms_reserve(p_id,p_purpose,p_user,p_session,v_tenant,NULL,NULL,v_phone,p_digest);
        RETURN v_phone;
      END $$
    """,
        "platform.auth_start_sms(uuid,text,uuid,uuid,text,text)",
        "platform_web",
    )
    _function(
        """
      CREATE FUNCTION platform.auth_sms_delivery(p_id uuid,p_sent boolean) RETURNS void
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
        UPDATE platform.sms_otp_challenges SET state=CASE WHEN p_sent THEN 'pending' ELSE 'failed' END
          WHERE id=p_id AND purpose<>'voice_identity' AND state='reserved'
      $$
    """,
        "platform.auth_sms_delivery(uuid,boolean)",
        "platform_web",
    )
    _function(
        """
      CREATE FUNCTION platform.auth_complete_sms(p_id uuid,p_purpose text,p_digest text,p_user uuid,p_session uuid,p_request text)
      RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v platform.sms_otp_challenges%ROWTYPE; v_email text;
      BEGIN
        SELECT * INTO v FROM platform.sms_otp_challenges WHERE id=p_id AND purpose=p_purpose AND purpose<>'voice_identity' FOR UPDATE;
        IF NOT FOUND OR v.state<>'pending' OR v.expires_at<=clock_timestamp() OR v.attempts>=5 THEN RETURN NULL; END IF;
        IF p_purpose<>'staff_login' AND (v.user_id IS DISTINCT FROM p_user OR v.auth_session_id IS DISTINCT FROM p_session
          OR NOT EXISTS(SELECT 1 FROM platform.auth_sessions s WHERE s.id=p_session AND s.user_id=p_user
            AND s.revoked_at IS NULL AND s.idle_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp())) THEN RETURN NULL; END IF;
        UPDATE platform.sms_otp_challenges SET attempts=attempts+1,
          state=CASE WHEN code_digest=p_digest THEN 'consumed' WHEN attempts+1>=5 THEN 'failed' ELSE 'pending' END,
          consumed_at=CASE WHEN code_digest=p_digest THEN clock_timestamp() END WHERE id=p_id;
        IF v.code_digest IS DISTINCT FROM p_digest THEN RETURN NULL; END IF;
        SELECT u.email::text INTO v_email FROM public.users u JOIN platform.auth_credentials c ON c.user_id=u.id
          WHERE u.id=v.user_id AND u.status='active' AND c.password_hash=v.password_snapshot
            AND (c.locked_until IS NULL OR c.locked_until<=clock_timestamp());
        IF v_email IS NULL THEN RETURN NULL; END IF;
        IF p_purpose='staff_enrollment' THEN
          INSERT INTO platform.staff_sms_credentials(user_id,phone_e164) VALUES(v.user_id,v.phone_e164) ON CONFLICT DO NOTHING;
          IF NOT FOUND THEN RETURN NULL; END IF;
          -- Other already-issued sessions must authenticate with the new factor.
          UPDATE platform.auth_sessions SET revoked_at=clock_timestamp(),revocation_reason='sms_enrolled'
            WHERE user_id=v.user_id AND id<>p_session AND revoked_at IS NULL;
        ELSIF p_purpose IN ('staff_login','staff_disable') THEN
          IF platform.auth_sms_phone(v.user_id) IS DISTINCT FROM v.phone_e164 THEN RETURN NULL; END IF;
          IF p_purpose='staff_disable' THEN DELETE FROM platform.staff_sms_credentials WHERE user_id=v.user_id; END IF;
        END IF;
        INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,request_id,metadata)
          VALUES(v.tenant_id,v.user_id,'auth.sms.'||p_purpose||'.verified','sms_challenge',p_id,p_request,jsonb_build_object('purpose',p_purpose));
        RETURN v_email;
      END $$
    """,
        "platform.auth_complete_sms(uuid,text,text,uuid,uuid,text)",
        "platform_web",
    )
    _voice_functions()
    _function(
        """
      CREATE FUNCTION platform.voice_sms_unavailable(p_session uuid) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        UPDATE automation.voice_identity_verifications SET state=CASE WHEN on_failure='human_handoff' THEN 'escalated' ELSE 'failed' END,
          updated_at=clock_timestamp() WHERE tenant_id=platform.current_tenant_id() AND session_id=p_session
          AND sms_required AND state IN ('identity_required','collecting_identity');
        UPDATE automation.handoffs SET status='pending',assigned_user_id=NULL,accepted_at=NULL,
          reason_safe='SMS verification requires human follow-up.',updated_at=clock_timestamp()
          WHERE tenant_id=platform.current_tenant_id() AND id IN (SELECT handoff_id FROM automation.voice_identity_verifications
            WHERE tenant_id=platform.current_tenant_id() AND session_id=p_session AND state='escalated');
      END $$
    """,
        "platform.voice_sms_unavailable(uuid)",
        "platform_voice",
    )


def _voice_functions() -> None:
    _function(
        """
      CREATE FUNCTION platform.guard_voice_sms_unlock() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        IF NEW.sms_required AND NEW.state='context_unlocked' AND NEW.sms_verified_at IS NULL THEN
          RAISE EXCEPTION 'SMS verification required before disclosure' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$
    """,
        "platform.guard_voice_sms_unlock()",
    )
    op.execute("""CREATE TRIGGER guard_voice_sms_unlock BEFORE INSERT OR UPDATE ON automation.voice_identity_verifications
      FOR EACH ROW EXECUTE FUNCTION platform.guard_voice_sms_unlock()""")
    _function(
        """
      CREATE FUNCTION platform.prepare_voice_sms_verification(p_session uuid) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_contact uuid; v_policy jsonb; v_existing boolean;
      BEGIN
        SELECT contact_id INTO v_contact FROM public.sessions WHERE tenant_id=v_tenant AND session_id=p_session AND ended_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'active voice session required' USING ERRCODE='42501'; END IF;
        SELECT identity_verification_policy INTO v_policy FROM crm.tenant_settings WHERE tenant_id=v_tenant;
        SELECT EXISTS(SELECT 1 FROM automation.voice_identity_verifications WHERE tenant_id=v_tenant AND session_id=p_session) INTO v_existing;
        IF coalesce((v_policy->>'smsOtp')::boolean,false) AND platform.current_tenant_active()
          AND platform.current_tenant_feature_enabled('voice') THEN
          IF v_contact IS NULL THEN RETURN jsonb_build_object('required',true,'factors','["smsOtp"]'::jsonb,
            'state','escalated','maxAttempts',3,'remainingAttempts',0,'onFailure','human_handoff'); END IF;
          IF NOT v_existing AND v_contact IS NOT NULL THEN
            INSERT INTO automation.voice_identity_verifications(tenant_id,session_id,contact_id,required_factors,state,max_attempts,on_failure,context_disclosure,sms_required)
              VALUES(v_tenant,p_session,v_contact,ARRAY[]::text[],'identity_required',least((v_policy->>'maxAttempts')::int,5),v_policy->>'onFailure','after_verification',true);
            v_existing:=true;
          ELSE
            UPDATE automation.voice_identity_verifications SET sms_required=true,state=CASE WHEN state='context_unlocked' THEN 'identity_required' ELSE state END,
              verified_at=NULL,context_unlocked_at=NULL WHERE tenant_id=v_tenant AND session_id=p_session AND NOT sms_required;
          END IF;
        END IF;
        IF NOT v_existing THEN RETURN jsonb_build_object('required',false,'factors','[]'::jsonb,'state','context_unlocked','maxAttempts',0,'remainingAttempts',0,'onFailure','end_call'); END IF;
        RETURN platform.voice_identity_verification_requirements(p_session);
      END $$
    """,
        "platform.prepare_voice_sms_verification(uuid)",
        "platform_voice",
    )
    # Retain the existing verification fields and states, adding only the SMS factor.
    _execute("""
      CREATE OR REPLACE FUNCTION platform.voice_identity_verification_requirements(p_session_id uuid) RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT jsonb_build_object('required',v.state<>'context_unlocked',
          'factors',to_jsonb(v.required_factors)||CASE WHEN v.sms_required THEN '["smsOtp"]'::jsonb ELSE '[]'::jsonb END,
          'state',v.state,'maxAttempts',v.max_attempts,'remainingAttempts',v.max_attempts-v.attempts,'onFailure',v.on_failure)
        FROM automation.voice_identity_verifications v WHERE v.tenant_id=platform.current_tenant_id() AND v.session_id=p_session_id
      $$
    """)
    _function(
        """
      CREATE FUNCTION platform.voice_start_sms(p_id uuid,p_session uuid,p_digest text) RETURNS text
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v_contact uuid; v_phone text;
      BEGIN
        SELECT v.contact_id INTO v_contact FROM automation.voice_identity_verifications v JOIN public.sessions s
          ON s.tenant_id=v.tenant_id AND s.session_id=v.session_id AND s.contact_id=v.contact_id
          WHERE v.tenant_id=v_tenant AND v.session_id=p_session AND v.sms_required AND v.sms_verified_at IS NULL
          AND v.state IN ('identity_required','collecting_identity') AND s.ended_at IS NULL AND platform.current_tenant_active()
          AND platform.current_tenant_feature_enabled('voice') FOR UPDATE OF v;
        IF v_contact IS NULL THEN RAISE EXCEPTION 'SMS verification unavailable' USING ERRCODE='42501'; END IF;
        -- Exact transport identity pinned by the server. Never accept a caller/model destination.
        SELECT i.normalized_value INTO v_phone FROM crm.contact_channel_identities i
          WHERE i.tenant_id=v_tenant AND i.contact_id=v_contact AND i.id=service.voice_session_caller_identity(v_tenant,p_session)
          AND i.channel IN ('phone','whatsapp') AND i.validation_status NOT IN ('invalid','revoked');
        IF v_phone IS NULL THEN RAISE EXCEPTION 'stored caller number unavailable' USING ERRCODE='42501'; END IF;
        PERFORM platform.sms_reserve(p_id,'voice_identity',NULL,NULL,v_tenant,p_session,v_contact,v_phone,p_digest);
        RETURN v_phone;
      END $$
    """,
        "platform.voice_start_sms(uuid,uuid,text)",
        "platform_voice",
    )
    _function(
        """
      CREATE FUNCTION platform.voice_sms_delivery(p_id uuid,p_session uuid,p_sent boolean) RETURNS void
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
        UPDATE platform.sms_otp_challenges SET state=CASE WHEN p_sent THEN 'pending' ELSE 'failed' END
          WHERE id=p_id AND tenant_id=platform.current_tenant_id() AND voice_session_id=p_session AND purpose='voice_identity' AND state='reserved'
      $$
    """,
        "platform.voice_sms_delivery(uuid,uuid,boolean)",
        "platform_voice",
    )
    _function(
        """
      CREATE FUNCTION platform.voice_sms_challenge(p_session uuid) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT id FROM platform.sms_otp_challenges WHERE tenant_id=platform.current_tenant_id() AND voice_session_id=p_session
          AND purpose='voice_identity' AND state='pending' AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1
      $$
    """,
        "platform.voice_sms_challenge(uuid)",
        "platform_voice",
    )
    _function(
        """
      CREATE FUNCTION platform.voice_complete_sms(p_id uuid,p_session uuid,p_digest text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_tenant uuid:=platform.current_tenant_id(); v automation.voice_identity_verifications%ROWTYPE;
        c platform.sms_otp_challenges%ROWTYPE; v_matches boolean;
      BEGIN
        SELECT verification.* INTO v FROM automation.voice_identity_verifications verification JOIN public.sessions s
          ON s.tenant_id=verification.tenant_id AND s.session_id=verification.session_id AND s.contact_id=verification.contact_id
          WHERE verification.tenant_id=v_tenant AND verification.session_id=p_session AND verification.sms_required
          AND s.ended_at IS NULL AND platform.current_tenant_active() AND platform.current_tenant_feature_enabled('voice') FOR UPDATE OF verification;
        IF NOT FOUND THEN RAISE EXCEPTION 'SMS verification unavailable' USING ERRCODE='42501'; END IF;
        IF v.sms_verified_at IS NOT NULL THEN RETURN platform.voice_identity_verification_requirements(p_session)||jsonb_build_object('verified',true); END IF;
        IF v.state NOT IN ('identity_required','collecting_identity') THEN RETURN platform.voice_identity_verification_requirements(p_session)||jsonb_build_object('verified',false); END IF;
        SELECT * INTO c FROM platform.sms_otp_challenges WHERE id=p_id AND tenant_id=v_tenant AND voice_session_id=p_session
          AND contact_id=v.contact_id AND purpose='voice_identity' FOR UPDATE;
        v_matches:=FOUND AND c.state='pending' AND c.expires_at>clock_timestamp() AND c.attempts<5
          AND c.code_digest=p_digest AND EXISTS(SELECT 1 FROM crm.contact_channel_identities i WHERE i.tenant_id=v_tenant
            AND i.id=service.voice_session_caller_identity(v_tenant,p_session) AND i.contact_id=v.contact_id
            AND i.normalized_value=c.phone_e164 AND i.validation_status NOT IN ('invalid','revoked'));
        UPDATE platform.sms_otp_challenges SET attempts=least(attempts+1,5),
          state=CASE WHEN v_matches THEN 'consumed' WHEN attempts+1>=5 THEN 'failed' ELSE state END,
          consumed_at=CASE WHEN v_matches THEN clock_timestamp() END WHERE id=c.id;
        IF v_matches THEN
          UPDATE automation.voice_identity_verifications SET sms_verified_at=clock_timestamp(),
            state=CASE WHEN cardinality(required_factors)=0 THEN 'context_unlocked' ELSE state END,
            verified_at=CASE WHEN cardinality(required_factors)=0 THEN clock_timestamp() ELSE verified_at END,
            context_unlocked_at=CASE WHEN cardinality(required_factors)=0 THEN clock_timestamp() ELSE context_unlocked_at END
            WHERE tenant_id=v_tenant AND session_id=p_session;
        ELSE
          UPDATE automation.voice_identity_verifications SET attempts=attempts+1,
            state=CASE WHEN attempts+1>=max_attempts THEN CASE WHEN on_failure='human_handoff' THEN 'escalated' ELSE 'failed' END ELSE 'collecting_identity' END
            WHERE tenant_id=v_tenant AND session_id=p_session;
          IF v.attempts+1>=v.max_attempts AND v.on_failure='human_handoff' THEN
            UPDATE automation.handoffs SET status='pending',assigned_user_id=NULL,accepted_at=NULL,
              reason_safe='SMS verification requires human follow-up.',updated_at=clock_timestamp()
              WHERE tenant_id=v_tenant AND id=v.handoff_id;
          END IF;
        END IF;
        INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
          VALUES(v_tenant,'dispatcher','voice.sms.checked','voice_session',p_session,jsonb_build_object('verified',coalesce(v_matches,false)));
        RETURN platform.voice_identity_verification_requirements(p_session)||jsonb_build_object('verified',coalesce(v_matches,false));
      END $$
    """,
        "platform.voice_complete_sms(uuid,uuid,text)",
        "platform_voice",
    )


def downgrade() -> None:
    for signature in (
        "platform.voice_sms_unavailable(uuid)",
        "platform.voice_complete_sms(uuid,uuid,text)",
        "platform.voice_sms_challenge(uuid)",
        "platform.voice_sms_delivery(uuid,uuid,boolean)",
        "platform.voice_start_sms(uuid,uuid,text)",
        "platform.prepare_voice_sms_verification(uuid)",
        "platform.auth_complete_sms(uuid,text,text,uuid,uuid,text)",
        "platform.auth_sms_delivery(uuid,boolean)",
        "platform.auth_start_sms(uuid,text,uuid,uuid,text,text)",
        "platform.sms_reserve(uuid,text,uuid,uuid,uuid,uuid,uuid,text,text)",
        "platform.auth_sms_phone(uuid)",
    ):
        op.execute(f"DROP FUNCTION {signature}")
    op.execute("DROP TRIGGER guard_voice_sms_unlock ON automation.voice_identity_verifications")
    op.execute("DROP FUNCTION platform.guard_voice_sms_unlock()")
    _execute("""
      DELETE FROM automation.voice_identity_verifications WHERE handoff_id IS NULL;
      ALTER TABLE automation.voice_identity_verifications DROP CONSTRAINT ck_voice_identity_sms_binding,
        DROP CONSTRAINT ck_voice_identity_factors, DROP COLUMN sms_verified_at, DROP COLUMN sms_required,
        ALTER COLUMN handoff_id SET NOT NULL, ALTER COLUMN conversation_id SET NOT NULL,
        ADD CONSTRAINT ck_voice_identity_factors CHECK (cardinality(required_factors) BETWEEN 1 AND 4
          AND required_factors <@ ARRAY['fullName','phone','nationalId','customerNumber']::text[]);
      ALTER TABLE crm.tenant_settings DROP CONSTRAINT ck_identity_sms_option;
      DROP TABLE platform.sms_otp_challenges;
      DROP TABLE platform.staff_sms_credentials;
      CREATE OR REPLACE FUNCTION platform.voice_identity_verification_requirements(p_session_id uuid) RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT jsonb_build_object('required',v.state<>'context_unlocked','factors',to_jsonb(v.required_factors),
          'state',v.state,'maxAttempts',v.max_attempts,'remainingAttempts',v.max_attempts-v.attempts,'onFailure',v.on_failure)
        FROM automation.voice_identity_verifications v WHERE v.tenant_id=platform.current_tenant_id() AND v.session_id=p_session_id
      $$
    """)
