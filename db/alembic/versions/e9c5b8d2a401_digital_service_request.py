"""Customer-submitted digital service requests and explicit template eligibility.

Links are bearer capabilities stored only as SHA-256 hashes. They cannot
create a case until the customer explicitly submits; phone/text/photo ingress
cannot finalize the intake. Photos and the case commit in one transaction.
"""

# ruff: noqa: E501 -- reviewed SQL definitions
from alembic import op

revision = "e9c5b8d2a401"
down_revision = "d8b2f6a4c917"
branch_labels = None
depends_on = None


def execute(script: str) -> None:
    pending = ""
    for index, part in enumerate(script.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
            continue
        pieces = part.split(";")
        pending += pieces[0]
        for piece in pieces[1:]:
            if pending.strip():
                op.execute(pending.replace(":", r"\:"))
            pending = piece
    if pending.strip():
        op.execute(pending.replace(":", r"\:"))


def patch(signature: str, before: str, after: str) -> None:
    # Runs identically in Alembic online mode and its reviewed offline SQL.
    signature, before, after = (value.replace("'", "''") for value in (signature, before, after))
    op.execute(
        f"""DO $patch$
      DECLARE definition text:=pg_get_functiondef(to_regprocedure('{signature}'));
        needle text:='{before}'; replacement text:='{after}';
      BEGIN
        IF definition IS NULL OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
          RAISE EXCEPTION 'Unexpected digital-form migration predecessor'; END IF;
        EXECUTE replace(definition,needle,replacement);
      END $patch$""".replace(":", r"\:")
    )


CAPTURE_GUARD = """
        IF v_policy#>>'{whatsappFollowUp,mode}'='form' AND
          (coalesce(p_confirmed,false) OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_fields) k WHERE k NOT IN ('customerName','faultDescription'))) THEN
          RAISE EXCEPTION 'phone intake accepts only name and fault; submit the digital form to open a case' USING ERRCODE='22023';
        END IF;
"""


def upgrade() -> None:
    execute("""
      CREATE TABLE platform.whatsapp_template_policy(
        tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
        enabled boolean NOT NULL DEFAULT false
      );
      ALTER TABLE platform.whatsapp_template_policy ENABLE ROW LEVEL SECURITY;
      ALTER TABLE platform.whatsapp_template_policy FORCE ROW LEVEL SECURITY;
      CREATE POLICY whatsapp_template_policy_tenant ON platform.whatsapp_template_policy
        USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
      GRANT SELECT ON platform.whatsapp_template_policy TO platform_web,platform_messaging,platform_voice;
      GRANT SELECT,INSERT,UPDATE,DELETE ON platform.whatsapp_template_policy TO platform_migrator;
      DO $$ DECLARE prior text:=current_setting('app.current_tenant',true); BEGIN
        PERFORM set_config('app.current_tenant','00000000-0000-0000-0000-000000000001',true);
        INSERT INTO platform.whatsapp_template_policy(tenant_id,enabled)
          SELECT id,true FROM public.tenants WHERE id='00000000-0000-0000-0000-000000000001';
        PERFORM set_config('app.current_tenant',coalesce(prior,''),true);
      END $$;
      CREATE FUNCTION platform.whatsapp_templates_enabled() RETURNS boolean
        LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
          SELECT EXISTS(SELECT 1 FROM platform.whatsapp_template_policy
            WHERE tenant_id=platform.current_tenant_id() AND enabled)
        $$;
      REVOKE ALL ON FUNCTION platform.whatsapp_templates_enabled() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION platform.whatsapp_templates_enabled() TO platform_web,platform_messaging,platform_voice,platform_migrator;
      CREATE FUNCTION platform.guard_whatsapp_template_tenant() RETURNS trigger
        LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
          IF NEW.tenant_id IS DISTINCT FROM platform.current_tenant_id() OR NOT platform.whatsapp_templates_enabled() THEN
            RAISE EXCEPTION 'WhatsApp templates are not enabled for this tenant' USING ERRCODE='42501';
          END IF;
          RETURN NEW;
        END $$;
      REVOKE ALL ON FUNCTION platform.guard_whatsapp_template_tenant() FROM PUBLIC;
      CREATE TRIGGER whatsapp_template_tenant BEFORE INSERT OR UPDATE OF message_kind ON messaging.outbound_requests
        FOR EACH ROW WHEN(NEW.message_kind='template') EXECUTE FUNCTION platform.guard_whatsapp_template_tenant();
      CREATE TRIGGER whatsapp_auto_greeting_tenant BEFORE INSERT OR UPDATE ON messaging.whatsapp_auto_greetings
        FOR EACH ROW WHEN(NEW.enabled) EXECUTE FUNCTION platform.guard_whatsapp_template_tenant();
      CREATE TRIGGER whatsapp_opening_menu_tenant BEFORE INSERT OR UPDATE ON platform.whatsapp_opening_menu_configuration
        FOR EACH ROW WHEN(NEW.enabled) EXECUTE FUNCTION platform.guard_whatsapp_template_tenant();

      CREATE TABLE service.digital_intake_forms(
        tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
        intake_id uuid NOT NULL,
        token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
        expires_at timestamptz NOT NULL,
        submitted_at timestamptz,
        submission_transaction bigint,
        case_id uuid,
        PRIMARY KEY(tenant_id,intake_id),
        UNIQUE(tenant_id,token_hash),
        FOREIGN KEY(tenant_id,intake_id) REFERENCES service.intake_drafts(tenant_id,id) ON DELETE CASCADE,
        FOREIGN KEY(tenant_id,case_id) REFERENCES service.cases(tenant_id,id)
      );
      ALTER TABLE service.digital_intake_forms ENABLE ROW LEVEL SECURITY;
      ALTER TABLE service.digital_intake_forms FORCE ROW LEVEL SECURITY;
      CREATE POLICY digital_intake_forms_tenant ON service.digital_intake_forms
        USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
      GRANT SELECT,INSERT,UPDATE,DELETE ON service.digital_intake_forms TO platform_migrator;

      CREATE FUNCTION service.issue_digital_intake_form(p_intake uuid,p_hash text) RETURNS uuid
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_tenant uuid:=platform.current_tenant_id(); v_intake service.intake_drafts%ROWTYPE;
        BEGIN
          IF NOT platform.current_tenant_active() OR NOT service.field_service_enabled()
            OR NOT platform.current_tenant_feature_enabled('field_service')
            OR NOT platform.current_tenant_feature_enabled('tickets')
            OR NOT platform.current_tenant_feature_enabled('whatsapp') THEN
            RAISE EXCEPTION 'service form unavailable' USING ERRCODE='42501'; END IF;
          SELECT * INTO v_intake FROM service.intake_drafts WHERE tenant_id=v_tenant AND id=p_intake FOR UPDATE;
          IF NOT FOUND OR v_intake.source_session_id IS NULL OR v_intake.workflow_policy#>>'{whatsappFollowUp,mode}' IS DISTINCT FROM 'form'
            OR v_intake.status NOT IN ('collecting','awaiting_confirmation')
            OR v_intake.followup_status NOT IN ('requested','queued')
            OR nullif(btrim(v_intake.collected_fields->>'customerName'),'') IS NULL
            OR nullif(btrim(v_intake.collected_fields->>'faultDescription'),'') IS NULL THEN
            RAISE EXCEPTION 'name and fault are required before the form link' USING ERRCODE='22023'; END IF;
          INSERT INTO service.digital_intake_forms(tenant_id,intake_id,token_hash,expires_at)
            VALUES(v_tenant,p_intake,p_hash,clock_timestamp()+interval '72 hours')
            ON CONFLICT(tenant_id,intake_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at
              WHERE service.digital_intake_forms.submitted_at IS NULL;
          RETURN v_tenant;
        END $$;

      CREATE FUNCTION service.read_digital_intake_form(p_hash text) RETURNS jsonb
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT jsonb_build_object('intakeId',intake.id,
            'businessName',left(coalesce(nullif(btrim(settings.business_name),''),tenant.name),160),
            'customerName',coalesce(intake.collected_fields->>'customerName',''),
            'faultDescription',coalesce(intake.collected_fields->>'faultDescription',''),
            'photoRequired',intake.workflow_policy->>'photoPolicy'='required',
            'submitted',form.submitted_at IS NOT NULL,'reference',service_case.reference)
          FROM service.digital_intake_forms form
          JOIN public.tenants tenant ON tenant.id=form.tenant_id
          LEFT JOIN crm.tenant_settings settings ON settings.tenant_id=form.tenant_id
          JOIN service.intake_drafts intake ON intake.tenant_id=form.tenant_id AND intake.id=form.intake_id
          LEFT JOIN service.cases service_case ON service_case.tenant_id=form.tenant_id AND service_case.id=form.case_id
          WHERE form.tenant_id=platform.current_tenant_id() AND form.token_hash=p_hash AND form.expires_at>clock_timestamp()
            AND intake.status IN ('collecting','awaiting_confirmation','confirmed')
            AND platform.current_tenant_active() AND service.field_service_enabled()
            AND platform.current_tenant_feature_enabled('field_service')
            AND platform.current_tenant_feature_enabled('tickets')
        $$;

      CREATE FUNCTION service.guard_digital_intake_case() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
          IF EXISTS(SELECT 1 FROM service.intake_drafts intake WHERE intake.tenant_id=NEW.tenant_id
            AND intake.id=NEW.intake_draft_id AND intake.workflow_policy#>>'{whatsappFollowUp,mode}'='form')
            AND NOT EXISTS(SELECT 1 FROM service.digital_intake_forms form WHERE form.tenant_id=NEW.tenant_id
              AND form.intake_id=NEW.intake_draft_id AND form.submitted_at IS NOT NULL
              AND form.submission_transaction=txid_current()) THEN
            RAISE EXCEPTION 'customer must submit the digital form first' USING ERRCODE='42501'; END IF;
          RETURN NEW;
        END $$;
      REVOKE ALL ON FUNCTION service.guard_digital_intake_case() FROM PUBLIC;
      CREATE TRIGGER digital_intake_case_submission BEFORE INSERT ON service.cases
        FOR EACH ROW EXECUTE FUNCTION service.guard_digital_intake_case();

      CREATE FUNCTION service.submit_digital_intake_form(p_hash text,p_name text,p_location text,p_fault text,p_confirmed boolean,p_photos jsonb) RETURNS jsonb
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE v_tenant uuid:=platform.current_tenant_id(); v_form service.digital_intake_forms%ROWTYPE;
          v_intake service.intake_drafts%ROWTYPE; v_receipt jsonb; v_photo jsonb; v_object uuid;
        BEGIN
          SELECT * INTO v_form FROM service.digital_intake_forms WHERE tenant_id=v_tenant AND token_hash=p_hash FOR UPDATE;
          IF NOT FOUND OR v_form.expires_at<=clock_timestamp() OR NOT platform.current_tenant_active()
            OR NOT service.field_service_enabled() OR NOT platform.current_tenant_feature_enabled('field_service')
            OR NOT platform.current_tenant_feature_enabled('tickets') THEN
            RAISE EXCEPTION 'service form unavailable' USING ERRCODE='P0002'; END IF;
          IF v_form.submitted_at IS NOT NULL THEN
            RETURN (SELECT jsonb_build_object('reference',reference,'created',false) FROM service.cases WHERE tenant_id=v_tenant AND id=v_form.case_id);
          END IF;
          SELECT * INTO v_intake FROM service.intake_drafts WHERE tenant_id=v_tenant AND id=v_form.intake_id FOR UPDATE;
          IF v_intake.status NOT IN ('collecting','awaiting_confirmation') OR v_intake.followup_status<>'admitted' THEN
            RAISE EXCEPTION 'service form unavailable' USING ERRCODE='P0002'; END IF;
          IF p_confirmed IS DISTINCT FROM true OR coalesce(char_length(btrim(p_name)),0) NOT BETWEEN 1 AND 160
            OR coalesce(char_length(btrim(p_location)),0) NOT BETWEEN 1 AND 500 OR coalesce(char_length(btrim(p_fault)),0) NOT BETWEEN 1 AND 4000
            OR jsonb_typeof(p_photos) IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'complete and confirm the form' USING ERRCODE='22023'; END IF;
          IF jsonb_array_length(p_photos)>5 OR (v_intake.workflow_policy->>'photoPolicy'='required' AND jsonb_array_length(p_photos)=0) THEN
            RAISE EXCEPTION 'invalid number of photos' USING ERRCODE='22023'; END IF;
          IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_photos) photo WHERE
            jsonb_typeof(photo) IS DISTINCT FROM 'object'
            OR jsonb_typeof(photo->'contentType') IS DISTINCT FROM 'string'
            OR coalesce(photo->>'contentType','') NOT IN ('image/jpeg','image/png','image/webp')
            OR CASE WHEN jsonb_typeof(photo->'byteSize')='number'
              AND photo->>'byteSize' ~ '^[0-9]{1,8}$'
              THEN (photo->>'byteSize')::bigint NOT BETWEEN 1 AND 12582912 ELSE true END
            OR jsonb_typeof(photo->'storageBackend') IS DISTINCT FROM 'string'
            OR photo->>'storageBackend' IS DISTINCT FROM 'local'
            OR jsonb_typeof(photo->'checksum') IS DISTINCT FROM 'string'
            OR coalesce(photo->>'checksum','') !~ '^[0-9a-f]{64}$'
            OR jsonb_typeof(photo->'storageKey') IS DISTINCT FROM 'string'
            OR coalesce(photo->>'storageKey','') NOT LIKE v_tenant::text||'/field-service/'||v_intake.id::text||'/customer_photo/%'
            OR photo->>'storageKey' ~ '(^|/)\\.\\.(/|$)'
            OR position(chr(92) in photo->>'storageKey')>0) THEN
            RAISE EXCEPTION 'invalid photo metadata' USING ERRCODE='22023'; END IF;
          IF (SELECT count(*)<>count(DISTINCT photo->>'storageKey') FROM jsonb_array_elements(p_photos) photo)
            OR (SELECT coalesce(sum((photo->>'byteSize')::bigint),0) FROM jsonb_array_elements(p_photos) photo)>20971520 THEN
            RAISE EXCEPTION 'invalid photo metadata' USING ERRCODE='22023'; END IF;
          UPDATE service.intake_drafts SET collected_fields=collected_fields||jsonb_build_object('customerName',btrim(p_name),'serviceAddress',btrim(p_location),'faultDescription',btrim(p_fault)),
            updated_at=clock_timestamp() WHERE tenant_id=v_tenant AND id=v_intake.id;
          UPDATE service.digital_intake_forms SET submitted_at=clock_timestamp(),submission_transaction=txid_current()
            WHERE tenant_id=v_tenant AND intake_id=v_intake.id;
          v_receipt:=service.open_form_intake_case(v_intake.id);
          IF v_receipt->>'status' IS DISTINCT FROM 'opened' THEN
            RAISE EXCEPTION 'service form could not be completed' USING ERRCODE='22023'; END IF;
          UPDATE service.digital_intake_forms SET case_id=(v_receipt->>'caseId')::uuid WHERE tenant_id=v_tenant AND intake_id=v_intake.id;
          FOR v_photo IN SELECT * FROM jsonb_array_elements(p_photos) LOOP
            INSERT INTO objects.object_metadata(tenant_id,owner_type,owner_id,category,content_type,byte_size,checksum,storage_backend,storage_key,status)
              VALUES(v_tenant,'service_case',(v_receipt->>'caseId')::uuid,'customer_photo',v_photo->>'contentType',(v_photo->>'byteSize')::bigint,
                v_photo->>'checksum','local',v_photo->>'storageKey','available') RETURNING id INTO v_object;
            INSERT INTO service.report_attachments(tenant_id,case_id,object_id,category,source,processing_status)
              VALUES(v_tenant,(v_receipt->>'caseId')::uuid,v_object,'customer_photo','customer','available');
          END LOOP;
          RETURN jsonb_build_object('reference',v_receipt->>'reference','created',true);
        END $$;
      REVOKE ALL ON FUNCTION service.issue_digital_intake_form(uuid,text),service.read_digital_intake_form(text),
        service.submit_digital_intake_form(text,text,text,text,boolean,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION service.issue_digital_intake_form(uuid,text) TO platform_messaging;
      GRANT EXECUTE ON FUNCTION service.read_digital_intake_form(text),service.submit_digital_intake_form(text,text,text,text,boolean,jsonb) TO platform_web;
      REVOKE EXECUTE ON FUNCTION service.open_form_intake_case(uuid) FROM platform_messaging;
    """)
    patch(
        "service.capture_service_intake(uuid,jsonb,boolean)",
        "v_policy:=v_context->'policy';",
        "v_policy:=v_context->'policy';" + CAPTURE_GUARD,
    )
    patch(
        "service.request_intake_followup(uuid,boolean)",
        "v_policy:=v_context->'policy';",
        """v_policy:=v_context->'policy';
        IF v_policy#>>'{whatsappFollowUp,mode}'='form' AND (
          v_policy#>>'{whatsappFollowUp,trigger}' IS DISTINCT FROM 'intake_saved'
          OR nullif(btrim(v_context#>>'{knownFields,customerName}'),'') IS NULL
          OR nullif(btrim(v_context#>>'{knownFields,faultDescription}'),'') IS NULL) THEN
          RETURN jsonb_build_object('status','unavailable','reason','name_and_fault_required'); END IF;
    """,
    )
    patch(
        "service.request_intake_followup(uuid,boolean)",
        "AND v_policy#>>'{whatsappFollowUp,templateName}' IS NULL",
        "",
    )
    patch(
        "service.request_intake_followup(uuid,boolean)",
        "followup_status IN ('not_requested','blocked_consent','no_recipient')",
        "followup_status IN ('not_requested','blocked_consent','no_recipient','blocked_window')",
    )
    patch(
        "service.request_intake_followup(uuid,boolean)",
        "v_job:=service.enqueue_intake_followup(v_tenant,v_intake,'in_call_request');",
        """v_job:=service.enqueue_intake_followup(v_tenant,v_intake,'in_call_request');
        IF v_policy#>>'{whatsappFollowUp,mode}'='form' AND NOT EXISTS(
          SELECT 1 FROM ops.jobs WHERE tenant_id=v_tenant AND id=v_job
            AND job_type='field_service.intake_followup' AND reference_id=v_intake
            AND status IN ('queued','running','retry')) THEN
          RETURN jsonb_build_object('status','unavailable','reason','followup_job_not_pending','intakeId',v_intake);
        END IF;""",
    )
    patch(
        "service.open_voice_inquiry(uuid)",
        "v_policy:=v_context->'policy';",
        "v_policy:=v_context->'policy'; IF v_policy#>>'{whatsappFollowUp,mode}'='form' THEN RETURN jsonb_build_object('status','not_configured'); END IF;",
    )
    patch(
        "support.open_ticket_from_voice_session(uuid,text,text)",
        "IF v_tenant IS NULL THEN",
        "IF service.current_workflow_policy()#>>'{whatsappFollowUp,mode}'='form' THEN RAISE EXCEPTION 'submit the digital service form first' USING ERRCODE='42501'; END IF; IF v_tenant IS NULL THEN",
    )
    patch(
        "service.escalate_voice_emergency(uuid,text)",
        "IF NOT service.field_service_enabled()",
        "IF service.current_workflow_policy()#>>'{whatsappFollowUp,mode}'='form' THEN RETURN jsonb_build_object('status','not_configured'); END IF; IF NOT service.field_service_enabled()",
    )
    # Photo requirements are checked against the submitted upload array; raw
    # WhatsApp photos cannot finalize the form. Only the guarded submit calls it.
    patch(
        "service.open_form_intake_case(uuid)",
        "OR (v_policy->>'photoPolicy'='required' AND NOT service.intake_has_photo(p_intake))",
        "OR NOT EXISTS(SELECT 1 FROM service.digital_intake_forms WHERE tenant_id=v_tenant AND intake_id=p_intake AND submitted_at IS NOT NULL AND submission_transaction=txid_current())",
    )
    patch(
        "service.open_form_intake_case(uuid)",
        "IF v_fields->>'storeId' IS NOT NULL THEN",
        "IF nullif(v_fields->>'storeName','') IS NULL THEN v_fields:=v_fields||jsonb_build_object('storeName',left(v_fields->>'serviceAddress',160)); END IF; IF v_fields->>'storeId' IS NOT NULL THEN",
    )
    # The generated display name is bounded; its full address and customer
    # still distinguish locations with the same truncated prefix.
    patch(
        "service.open_form_intake_case(uuid)",
        "AND lower(name)=lower(v_fields->>'storeName') AND archived_at IS NULL ORDER BY id LIMIT 1;",
        "AND lower(name)=lower(v_fields->>'storeName') AND archived_at IS NULL AND (nullif(v_intake.collected_fields->>'storeName','') IS NOT NULL OR (customer_contact_id IS NOT DISTINCT FROM v_contact AND address IS NOT DISTINCT FROM v_fields->>'serviceAddress')) ORDER BY id LIMIT 1;",
    )


def downgrade() -> None:
    # Capability URLs and submission receipts remain valid on a code rollback.
    # Dropping them would re-enable the unconfirmed text-reply opening path.
    # Roll back compatible application images while retaining this schema.
    # An empty downgrade would falsely stamp the predecessor and break upgrade.
    raise RuntimeError(
        "Digital service submission is forward-only; roll back compatible application "
        "images while retaining revision e9c5b8d2a401."
    )
