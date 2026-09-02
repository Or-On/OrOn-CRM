"""add scoped cross channel voice job consumer

Revision ID: 3f6133842389
Revises: 9d3038bec65e
Create Date: 2026-09-02 23:00:52.730817
"""

from collections.abc import Sequence

from alembic import op

revision: str = "3f6133842389"
down_revision: str | None = "9d3038bec65e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE FUNCTION ops.claim_voice_simulation(p_worker text)
        RETURNS TABLE(id uuid, tenant_id uuid)
        LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
          WITH candidate AS (
            SELECT job.id FROM ops.jobs job
            WHERE queue = 'voice' AND job_type = 'cross_channel.voice_call.simulated'
              AND tenant_id IS NOT NULL
              AND ((status IN ('queued','retry') AND attempts < max_attempts
                    AND available_at <= CURRENT_TIMESTAMP)
                OR (status = 'running' AND locked_at < CURRENT_TIMESTAMP - interval '60 seconds'))
            ORDER BY priority DESC, available_at, id
            FOR UPDATE SKIP LOCKED LIMIT 1
          )
          UPDATE ops.jobs job SET status = 'running', attempts = LEAST(attempts + 1, max_attempts),
            locked_at = CURRENT_TIMESTAMP, locked_by = p_worker,
            updated_at = CURRENT_TIMESTAMP
          FROM candidate WHERE job.id = candidate.id
          RETURNING job.id, job.tenant_id
        $$
    """)
    op.execute("REVOKE ALL ON FUNCTION ops.claim_voice_simulation(text) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION ops.claim_voice_simulation(text) TO platform_voice")
    op.execute("GRANT SELECT, UPDATE ON ops.jobs TO platform_voice")
    op.execute("""
        CREATE POLICY voice_simulation_jobs ON ops.jobs AS RESTRICTIVE
        FOR ALL TO platform_voice
        USING (tenant_id = platform.current_tenant_id() AND queue = 'voice'
               AND job_type = 'cross_channel.voice_call.simulated')
        WITH CHECK (tenant_id = platform.current_tenant_id() AND queue = 'voice'
                    AND job_type = 'cross_channel.voice_call.simulated')
    """)
    # Locks consent and membership until the simulator transaction commits, without
    # granting the voice role direct access to messaging or identity tables.
    op.execute("""
        CREATE FUNCTION platform.voice_simulation_eligible(p_contact uuid, p_conversation uuid)
        RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
          SELECT EXISTS (
            SELECT 1 FROM crm.contacts contact
            JOIN messaging.conversations conversation
              ON conversation.contact_id = contact.id AND conversation.tenant_id = contact.tenant_id
            JOIN public.memberships member ON member.tenant_id = contact.tenant_id
            JOIN public.users actor ON actor.id = member.user_id
            JOIN public.tenants tenant ON tenant.id = contact.tenant_id
            WHERE contact.id = p_contact AND conversation.id = p_conversation
              AND contact.tenant_id = platform.current_tenant_id()
              AND member.user_id = platform.current_user_id()
              AND member.role IN ('owner','admin','editor','agent')
              AND actor.status = 'active' AND tenant.status = 'active'
              AND contact.voice_consent = 'granted' AND contact.lifecycle_status = 'active'
            FOR SHARE OF contact, conversation, member, actor, tenant
          )
        $$
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.voice_simulation_eligible(uuid, uuid) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.voice_simulation_eligible(uuid, uuid) TO platform_voice"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.voice_simulation_eligible(uuid, uuid)")
    op.execute("DROP POLICY voice_simulation_jobs ON ops.jobs")
    op.execute("REVOKE SELECT, UPDATE ON ops.jobs FROM platform_voice")
    op.execute("DROP FUNCTION ops.claim_voice_simulation(text)")
