"""Version public form addresses; retain the explicitly legacy submission path."""

# ruff: noqa: E501 -- reviewed SQL
from alembic import op

revision = "f4b9d1e62080"
down_revision = "f3a8c2d91750"
branch_labels = None
depends_on = None


def patch(signature: str, before: str, after: str) -> None:
    signature, before, after = (v.replace("'", "''") for v in (signature, before, after))
    op.execute(
        f"""DO $patch$ DECLARE body text:=pg_get_functiondef('{signature}'::regprocedure);
      BEGIN IF strpos(body,'{before}')=0 THEN RAISE EXCEPTION 'Unexpected address migration predecessor'; END IF;
      EXECUTE replace(body,'{before}','{after}'); END $patch$""".replace(":", r"\:")
    )


READ_BEFORE = "'customerName',coalesce(intake.collected_fields->>'customerName',''),"
READ_AFTER = """'formVersion',form.form_version,
  'businessPhone',CASE WHEN settings.business_phone ~ '^\\+[1-9][0-9]{7,14}$' THEN settings.business_phone ELSE NULL END,
  'customerName',coalesce(intake.collected_fields->>'customerName',''),"""
STORE_BEFORE = "jsonb_build_object('storeName',left(v_fields->>'serviceAddress',160))"
STORE_AFTER = "jsonb_build_object('storeName','מיקום שירות')"


def upgrade() -> None:
    op.execute(
        "ALTER TABLE crm.service_locations ADD COLUMN city text CHECK (city IS NULL OR char_length(city) BETWEEN 1 AND 120)"
    )
    # Existing issued capabilities stay v1, including clients already loaded in a browser.
    op.execute(
        "ALTER TABLE service.digital_intake_forms ADD COLUMN form_version integer NOT NULL DEFAULT 1 CHECK(form_version IN (1,2))"
    )
    op.execute("ALTER TABLE service.digital_intake_forms ALTER COLUMN form_version SET DEFAULT 2")
    patch("service.read_digital_intake_form(text)", READ_BEFORE, READ_AFTER)
    patch("service.open_form_intake_case(uuid)", STORE_BEFORE, STORE_AFTER)
    op.execute(
        "ALTER FUNCTION service.submit_digital_intake_form(text,text,text,text,boolean,jsonb) RENAME TO submit_digital_intake_form_core"
    )
    op.execute(
        "REVOKE ALL ON FUNCTION service.submit_digital_intake_form_core(text,text,text,text,boolean,jsonb) FROM PUBLIC,platform_web,platform_messaging"
    )
    op.execute("""CREATE FUNCTION service.submit_digital_intake_form(p_hash text,p_name text,p_location text,p_fault text,p_confirmed boolean,p_photos jsonb) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        IF service.read_digital_intake_form(p_hash) IS NULL THEN RAISE EXCEPTION 'service form unavailable' USING ERRCODE='P0002'; END IF;
        IF NOT EXISTS(SELECT 1 FROM service.digital_intake_forms WHERE tenant_id=platform.current_tenant_id() AND token_hash=p_hash AND form_version=1) THEN
          RAISE EXCEPTION 'street and city are required for this form' USING ERRCODE='22023'; END IF;
        RETURN service.submit_digital_intake_form_core(p_hash,p_name,p_location,p_fault,p_confirmed,p_photos);
      END $$""")
    op.execute("""CREATE FUNCTION service.submit_digital_intake_form_v2(p_hash text,p_name text,p_street text,p_city text,p_fault text,p_confirmed boolean,p_photos jsonb) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE v_form service.digital_intake_forms%ROWTYPE; receipt jsonb;
      BEGIN
        SELECT * INTO v_form FROM service.digital_intake_forms WHERE tenant_id=platform.current_tenant_id() AND token_hash=p_hash FOR UPDATE;
        IF NOT FOUND OR service.read_digital_intake_form(p_hash) IS NULL THEN RAISE EXCEPTION 'service form unavailable' USING ERRCODE='P0002'; END IF;
        IF coalesce(char_length(btrim(p_street)),0) NOT BETWEEN 1 AND 350 OR coalesce(char_length(btrim(p_city)),0) NOT BETWEEN 1 AND 120 THEN
          RAISE EXCEPTION 'street and city required' USING ERRCODE='22023'; END IF;
        IF v_form.submitted_at IS NULL THEN
          UPDATE service.intake_drafts SET collected_fields=collected_fields || jsonb_build_object('serviceStreet',btrim(p_street),'serviceCity',btrim(p_city))
            WHERE tenant_id=v_form.tenant_id AND id=v_form.intake_id;
        END IF;
        receipt:=service.submit_digital_intake_form_core(p_hash,p_name,btrim(p_street)||', '||btrim(p_city),p_fault,p_confirmed,p_photos);
        IF (receipt->>'created')::boolean THEN
          UPDATE crm.service_locations location SET city=btrim(p_city) FROM service.cases c
          WHERE c.tenant_id=v_form.tenant_id AND c.intake_draft_id=v_form.intake_id AND location.tenant_id=c.tenant_id AND location.id=c.service_location_id;
        END IF;
        RETURN receipt;
      END $$""")
    for signature in [
        "service.submit_digital_intake_form(text,text,text,text,boolean,jsonb)",
        "service.submit_digital_intake_form_v2(text,text,text,text,text,boolean,jsonb)",
    ]:
        op.execute(f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC")
        op.execute(f"GRANT EXECUTE ON FUNCTION {signature} TO platform_web")


def downgrade() -> None:
    op.execute(
        "DROP FUNCTION service.submit_digital_intake_form_v2(text,text,text,text,text,boolean,jsonb)"
    )
    op.execute(
        "DROP FUNCTION service.submit_digital_intake_form(text,text,text,text,boolean,jsonb)"
    )
    op.execute(
        "ALTER FUNCTION service.submit_digital_intake_form_core(text,text,text,text,boolean,jsonb) RENAME TO submit_digital_intake_form"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION service.submit_digital_intake_form(text,text,text,text,boolean,jsonb) TO platform_web"
    )
    patch("service.read_digital_intake_form(text)", READ_AFTER, READ_BEFORE)
    patch("service.open_form_intake_case(uuid)", STORE_AFTER, STORE_BEFORE)
    # Customer street/city remain in intake.collected_fields on rollback.
    op.execute("ALTER TABLE service.digital_intake_forms DROP COLUMN form_version")
    op.execute("ALTER TABLE crm.service_locations DROP COLUMN city")
