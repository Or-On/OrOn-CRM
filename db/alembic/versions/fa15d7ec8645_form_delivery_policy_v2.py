"""Version template parameters; migrations never approve or enable templates."""

# ruff: noqa: E501, UP031 -- literal SQL patch fragments, never request data
from alembic import op

revision = "fa15d7ec8645"
down_revision = "f904d6eb7534"
branch_labels = None
depends_on = None


def patch(signature: str, old: str, new: str) -> None:
    op.execute(
        """DO $patch$ DECLARE definition text:=pg_get_functiondef('%s'::regprocedure);
      needle text:=$old$%s$old$; replacement text:=$new$%s$new$;
      BEGIN
        IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
          RAISE EXCEPTION 'Unexpected form delivery policy predecessor'; END IF;
        EXECUTE replace(definition,needle,replacement);
      END $patch$"""
        % (signature, old, new)
    )


TEMPLATE = "platform.whatsapp_template_request_allowed(messaging.outbound_requests)"
CONFIG = "service.whatsapp_form_template_configuration(uuid)"
RECIPIENT = "service.verified_followup_recipient(uuid,uuid,uuid,text)"
EDITS = [
    (
        CONFIG,
        "'publicOrigin',policy.public_origin)",
        "'publicOrigin',policy.public_origin,'parameterCount',policy.parameter_count)",
    ),
    (
        TEMPLATE,
        "OR jsonb_array_length(p_request.template_parameters)<>1",
        "OR jsonb_array_length(p_request.template_parameters) NOT IN (1,3)",
    ),
    (
        TEMPLATE,
        "v_link:=p_request.template_parameters->>0;",
        """IF jsonb_array_length(p_request.template_parameters)<>v_policy.parameter_count THEN RETURN false; END IF;
          v_link:=p_request.template_parameters->>(CASE v_policy.parameter_count WHEN 3 THEN 1 ELSE 0 END);""",
    ),
    (
        TEMPLATE,
        "p_request.idempotency_key='service-followup:'||intake.id::text",
        """(p_request.idempotency_key='service-followup:'||intake.id::text
                OR p_request.idempotency_key='service-followup:'||intake.id::text||':attempt:'||intake.followup_attempt::text)""",
    ),
    (
        TEMPLATE,
        "AND form.submitted_at IS NULL AND form.expires_at>clock_timestamp()",
        """AND intake.followup_closed_at IS NULL
              AND (v_policy.parameter_count=1 OR (
                jsonb_typeof(p_request.template_parameters->1)='string'
                AND jsonb_typeof(p_request.template_parameters->2)='string'
                AND form.brand_snapshot->>'businessPhone' ~ '^[+][1-9][0-9]{7,14}$'
                AND p_request.template_parameters->>0=form.brand_snapshot->>'businessName'
                AND p_request.template_parameters->>2=form.brand_snapshot->>'businessPhone'))
              AND form.submitted_at IS NULL AND form.expires_at>clock_timestamp()""",
    ),
    (
        RECIPIENT,
        "AND intake.id=p_intake AND recipient.normalized_value=p_address",
        """AND intake.id=p_intake AND recipient.normalized_value=p_address
            AND intake.followup_closed_at IS NULL AND intake.status IN ('collecting','awaiting_confirmation')
            AND EXISTS(SELECT 1 FROM crm.contacts contact WHERE contact.tenant_id=intake.tenant_id
              AND contact.id=intake.reporting_contact_id AND contact.lifecycle_status='active'
              AND contact.whatsapp_consent='granted' AND contact.whatsapp_opted_out_at IS NULL)""",
    ),
]


def upgrade() -> None:
    op.execute(
        "ALTER TABLE service.whatsapp_form_template_policy ADD COLUMN parameter_count integer NOT NULL DEFAULT 1 CHECK(parameter_count IN (1,3))"
    )
    for signature, old, new in EDITS:
        patch(signature, old, new)


def downgrade() -> None:
    for signature, old, new in reversed(EDITS):
        patch(signature, new, old)
    op.execute("ALTER TABLE service.whatsapp_form_template_policy DROP COLUMN parameter_count")
