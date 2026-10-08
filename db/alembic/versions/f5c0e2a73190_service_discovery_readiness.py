"""Opt-in immutable schema policy enforces durable discovery completion in both channels."""

# ruff: noqa: E501 -- reviewed SQL
from alembic import op

revision = "f5c0e2a73190"
down_revision = "f4b9d1e62080"
branch_labels = None
depends_on = None

GUARD = """
  IF EXISTS(SELECT 1 FROM crm.lead_field_schemas schema WHERE schema.tenant_id=v_lead.tenant_id
      AND schema.id=v_lead.field_schema_id AND schema.version=v_lead.field_schema_version
      AND schema.completion_policy='service_discovery_v1') THEN
    IF EXISTS(SELECT 1 FROM unnest(ARRAY['service_interest','need_summary','contact_name','contact_phone','follow_up_allowed','discussion_complete']) required(key)
      WHERE NOT EXISTS(SELECT 1 FROM crm.lead_field_values value WHERE value.tenant_id=v_lead.tenant_id AND value.lead_id=v_lead.id
        AND value.field_key=required.key AND value.superseded_at IS NULL AND value.value_state='known'
        AND nullif(btrim(value.normalized_value),'') IS NOT NULL
        AND (required.key NOT IN ('follow_up_allowed','discussion_complete') OR value.normalized_value='true')
        AND (required.key<>'contact_phone' OR value.normalized_value ~ '^\\+[1-9][0-9]{7,14}$'))) THEN
      RAISE EXCEPTION 'lead is not ready for permitted human follow-up' USING ERRCODE='LD422';
    END IF;
    IF EXISTS(SELECT 1 FROM crm.contacts contact WHERE contact.tenant_id=v_lead.tenant_id AND contact.id=v_lead.contact_id
      AND (contact.lifecycle_status<>'active' OR contact.whatsapp_opted_out_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'contact is not eligible for follow-up' USING ERRCODE='LD422'; END IF;
  END IF;
"""
NEEDLE = "-- Collection completeness is not sales qualification"


def replace(before: str, after: str) -> None:
    before, after = before.replace("'", "''"), after.replace("'", "''")
    op.execute(
        f"""DO $patch$ DECLARE body text:=pg_get_functiondef('platform.lead_finalize(jsonb,uuid,text,integer,text,text)'::regprocedure);
      BEGIN IF strpos(body,'{before}')=0 THEN RAISE EXCEPTION 'Unexpected lead predecessor'; END IF;
      EXECUTE replace(body,'{before}','{after}'); END $patch$""".replace(":", r"\:")
    )


def upgrade() -> None:
    op.execute(
        "ALTER TABLE crm.lead_field_schemas ADD COLUMN completion_policy text CHECK(completion_policy IS NULL OR completion_policy='service_discovery_v1')"
    )
    replace(NEEDLE, GUARD + NEEDLE)


def downgrade() -> None:
    replace(GUARD + NEEDLE, NEEDLE)
    op.execute("ALTER TABLE crm.lead_field_schemas DROP COLUMN completion_policy")
