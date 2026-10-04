"""Expose only tenant-scoped remediation evidence existence to Inbox removal.

Revision ID: e60cf8597b40
Revises: e50be7486a3f
"""

from alembic import op

revision = "e60cf8597b40"
down_revision = "e50be7486a3f"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
      CREATE FUNCTION platform.conversation_has_remediation_evidence(p_conversation uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT EXISTS (
          SELECT 1 FROM messaging.conversations c JOIN public.tenants t ON t.id=c.tenant_id
          WHERE c.id=p_conversation AND c.tenant_id=platform.current_tenant_id()
            AND t.status='active' AND EXISTS (
              SELECT 1 FROM public.users u WHERE u.id=platform.current_user_id()
                AND u.status='active' AND (u.is_superuser OR EXISTS (
                  SELECT 1 FROM public.memberships m WHERE m.user_id=u.id
                    AND m.tenant_id=c.tenant_id))
            ) AND (
              EXISTS (SELECT 1 FROM agents.messaging_memory_sessions s
                WHERE s.tenant_id=c.tenant_id AND s.conversation_id=c.id)
              OR EXISTS (SELECT 1 FROM messaging.audio_transcription_work a
                JOIN messaging.messages m ON m.id=a.message_id AND m.tenant_id=a.tenant_id
                WHERE a.tenant_id=c.tenant_id AND m.conversation_id=c.id)
              OR EXISTS (SELECT 1 FROM agents.model_attempts a JOIN ops.jobs j ON j.id=a.job_id
                AND j.tenant_id=a.tenant_id WHERE a.tenant_id=c.tenant_id
                  AND j.reference_type='conversation' AND j.reference_id=c.id)
              OR EXISTS (SELECT 1 FROM agents.usage_events u JOIN ops.jobs j ON j.id=u.job_id
                AND j.tenant_id=u.tenant_id WHERE u.tenant_id=c.tenant_id
                  AND j.reference_type='conversation' AND j.reference_id=c.id)
              OR EXISTS (SELECT 1 FROM ops.jobs j WHERE j.tenant_id=c.tenant_id
                AND j.queue='messaging' AND j.job_type='whatsapp.ai.reply'
                AND j.reference_type='conversation' AND j.reference_id=c.id
                AND j.admitted_agent_version_id IS NOT NULL)
            )
        )
      $$
    """)
    op.execute(
        "REVOKE ALL ON FUNCTION platform.conversation_has_remediation_evidence(uuid) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.conversation_has_remediation_evidence(uuid) "
        "TO platform_web"
    )
    op.execute("""
      CREATE FUNCTION platform.current_actor_can_remove_conversation(p_actor uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT p_actor=platform.current_user_id()
          AND platform.messaging_ai_actor_authorized(p_actor)
      $$
    """)
    op.execute(
        "REVOKE ALL ON FUNCTION platform.current_actor_can_remove_conversation(uuid) FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.current_actor_can_remove_conversation(uuid) "
        "TO platform_web"
    )


def downgrade():
    op.execute("DROP FUNCTION platform.current_actor_can_remove_conversation(uuid)")
    op.execute("DROP FUNCTION platform.conversation_has_remediation_evidence(uuid)")
