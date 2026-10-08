"""Use the immutable inbound sender for staff recovery of direct WhatsApp forms."""

# ruff: noqa: E501 -- exact predecessor SQL fragments
from alembic import op

revision = "ff6a2c31db90"
down_revision = "fe591b20ca89"
branch_labels = None
depends_on = None

PREPARE = "service.prepare_intake_followup_recipient(uuid)"
VERIFY = "service.verified_followup_recipient(uuid,uuid,uuid,text)"
SOURCE = """(SELECT origin.contact_identity_id FROM service.whatsapp_form_sources source
  JOIN messaging.inbound_message_origins origin ON origin.tenant_id=source.tenant_id AND origin.message_id=source.trigger_message_id
  WHERE source.tenant_id={alias}.tenant_id AND source.intake_id={alias}.id AND source.conversation_id={alias}.conversation_id)"""
EDITS = [
    (
        PREPARE,
        "IF v_intake.source_session_id IS NULL THEN RETURN jsonb_build_object('status','no_recipient'); END IF;",
        """IF v_intake.source_session_id IS NULL AND NOT EXISTS(SELECT 1 FROM service.whatsapp_form_sources
       WHERE tenant_id=v_tenant AND intake_id=v_intake.id AND conversation_id=v_intake.conversation_id)
       THEN RETURN jsonb_build_object('status','no_recipient'); END IF;""",
    ),
    (
        PREPARE,
        "id=service.voice_session_caller_identity(v_tenant,v_intake.source_session_id)",
        "id=CASE WHEN v_intake.source_session_id IS NOT NULL THEN service.voice_session_caller_identity(v_tenant,v_intake.source_session_id) ELSE "
        + SOURCE.format(alias="v_intake")
        + " END",
    ),
    (
        PREPARE,
        "WHERE tenant_id=v_tenant AND kind='whatsapp' AND status='active' AND provider IN ('meta','simulator')",
        """WHERE tenant_id=v_tenant AND kind='whatsapp' AND status='active' AND provider IN ('meta','simulator')
       AND (v_intake.source_session_id IS NOT NULL OR id=(SELECT channel_id FROM messaging.conversations
         WHERE tenant_id=v_tenant AND id=v_intake.conversation_id))""",
    ),
    (
        VERIFY,
        "caller.id=service.voice_session_caller_identity(intake.tenant_id,intake.source_session_id)",
        "caller.id=CASE WHEN intake.source_session_id IS NOT NULL THEN service.voice_session_caller_identity(intake.tenant_id,intake.source_session_id) ELSE "
        + SOURCE.format(alias="intake")
        + " END",
    ),
]


def patch(signature: str, before: str, after: str) -> None:
    before, after = before.replace("'", "''"), after.replace("'", "''")
    op.execute(
        f"""DO $patch$ DECLARE body text:=pg_get_functiondef('{signature}'::regprocedure);
      BEGIN IF strpos(body,'{before}')=0 THEN RAISE EXCEPTION 'Unexpected direct form predecessor'; END IF;
      EXECUTE replace(body,'{before}','{after}'); END $patch$""".replace(":", r"\:")
    )


def upgrade() -> None:
    for signature, before, after in EDITS:
        patch(signature, before, after)


def downgrade() -> None:
    for signature, before, after in reversed(EDITS):
        patch(signature, after, before)
