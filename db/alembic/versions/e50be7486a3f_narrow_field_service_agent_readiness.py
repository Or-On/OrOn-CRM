"""Expose tenant-bound field service Agent readiness without settings access.

Revision ID: e50be7486a3f
Revises: e4fad637592e
"""

from alembic import op

revision = "e50be7486a3f"
down_revision = "e4fad637592e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
      CREATE FUNCTION platform.current_field_service_whatsapp_agent_ready()
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path=pg_catalog AS $$
        SELECT platform.current_tenant_active() AND EXISTS (
          SELECT 1 FROM crm.tenant_settings settings
          JOIN agents.agent_profiles profile
            ON profile.id=settings.whatsapp_ai_agent_profile_id
           AND profile.tenant_id=settings.tenant_id
           AND profile.archived_at IS NULL
          JOIN agents.agent_profile_versions version
            ON version.agent_profile_id=profile.id
           AND version.tenant_id=profile.tenant_id
           AND version.published_at IS NOT NULL
           AND version.validation_status='valid'
           AND version.channel_capabilities @> ARRAY['whatsapp']::text[]
          WHERE settings.tenant_id=platform.current_tenant_id()
            AND settings.whatsapp_ai_enabled_by_user_id IS NOT NULL
        )
      $$
    """)
    op.execute(
        "REVOKE ALL ON FUNCTION platform.current_field_service_whatsapp_agent_ready() FROM PUBLIC"
    )
    # Existing feature-state readers; voice lacks the underlying entitlement read.
    op.execute("""
      GRANT EXECUTE ON FUNCTION platform.current_field_service_whatsapp_agent_ready()
      TO platform_web,platform_worker,platform_messaging,platform_readonly
    """)
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "platform.current_tenant_member_display_name(uuid) TO platform_messaging"
    )


def downgrade() -> None:
    op.execute(
        "REVOKE EXECUTE ON FUNCTION "
        "platform.current_tenant_member_display_name(uuid) FROM platform_messaging"
    )
    op.execute("DROP FUNCTION platform.current_field_service_whatsapp_agent_ready()")
