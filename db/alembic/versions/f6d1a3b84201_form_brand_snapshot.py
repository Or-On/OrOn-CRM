"""Freeze form message branding at issuance; provider authorization stays live."""

# ruff: noqa: E501
from importlib import import_module

from alembic import op

revision = "f6d1a3b84201"
down_revision = "f5c0e2a73190"
branch_labels = None
depends_on = None
patch = import_module("db.alembic.versions.f4b9d1e62080_service_form_address_version").patch
NAME_BEFORE = (
    "'businessName',left(coalesce(nullif(btrim(settings.business_name),''),tenant.name),160),"
)
NAME_AFTER = "'businessName',coalesce(form.brand_snapshot->>'businessName',left(coalesce(nullif(btrim(settings.business_name),''),tenant.name),160)),"
PHONE_BEFORE = "'businessPhone',CASE WHEN settings.business_phone ~ '^\\+[1-9][0-9]{7,14}$' THEN settings.business_phone ELSE NULL END,"
PHONE_AFTER = "'businessPhone',CASE WHEN form.brand_snapshot IS NOT NULL THEN form.brand_snapshot->>'businessPhone' WHEN settings.business_phone ~ '^\\+[1-9][0-9]{7,14}$' THEN settings.business_phone ELSE NULL END,"


def upgrade() -> None:
    op.execute("ALTER TABLE service.digital_intake_forms ADD COLUMN brand_snapshot jsonb")
    patch("service.read_digital_intake_form(text)", NAME_BEFORE, NAME_AFTER)
    patch("service.read_digital_intake_form(text)", PHONE_BEFORE, PHONE_AFTER)
    op.execute("""CREATE FUNCTION service.capture_form_brand() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
        IF TG_OP='UPDATE' THEN NEW.brand_snapshot:=OLD.brand_snapshot; RETURN NEW; END IF;
        SELECT jsonb_build_object('businessName',left(btrim(regexp_replace(regexp_replace(coalesce(nullif(btrim(settings.business_name),''),tenant.name),'[[:cntrl:]<>`{}]','','g'),'[[:space:]]+',' ','g')),120),
          'businessPhone',CASE WHEN settings.business_phone ~ '^\\+[1-9][0-9]{7,14}$' THEN settings.business_phone ELSE NULL END)
          INTO NEW.brand_snapshot FROM public.tenants tenant LEFT JOIN crm.tenant_settings settings ON settings.tenant_id=tenant.id
          WHERE tenant.id=NEW.tenant_id;
        RETURN NEW;
      END $$""")
    op.execute("REVOKE ALL ON FUNCTION service.capture_form_brand() FROM PUBLIC")
    op.execute("""CREATE TRIGGER form_brand_snapshot BEFORE INSERT OR UPDATE ON service.digital_intake_forms
      FOR EACH ROW EXECUTE FUNCTION service.capture_form_brand()""")
    op.execute("""CREATE FUNCTION service.digital_form_brand_snapshot(p_hash text) RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT form.brand_snapshot FROM service.digital_intake_forms form
        WHERE form.tenant_id=platform.current_tenant_id() AND form.token_hash=p_hash
          AND form.expires_at>clock_timestamp() AND platform.current_tenant_active()
      $$""")
    op.execute("REVOKE ALL ON FUNCTION service.digital_form_brand_snapshot(text) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION service.digital_form_brand_snapshot(text) TO platform_web,platform_messaging"
    )


def downgrade() -> None:
    patch("service.read_digital_intake_form(text)", PHONE_AFTER, PHONE_BEFORE)
    patch("service.read_digital_intake_form(text)", NAME_AFTER, NAME_BEFORE)
    op.execute("DROP FUNCTION service.digital_form_brand_snapshot(text)")
    op.execute("DROP TRIGGER form_brand_snapshot ON service.digital_intake_forms")
    op.execute("DROP FUNCTION service.capture_form_brand()")
    op.execute("ALTER TABLE service.digital_intake_forms DROP COLUMN brand_snapshot")
