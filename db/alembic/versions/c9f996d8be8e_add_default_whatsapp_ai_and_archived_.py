"""add default whatsapp ai and archived definitions

Revision ID: c9f996d8be8e
Revises: 585ee9ec1ca8
Create Date: 2026-09-13 00:27:03.079276
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c9f996d8be8e"
down_revision: str | None = "585ee9ec1ca8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_profiles",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        schema="agents",
    )
    op.add_column(
        "flow_definitions",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        schema="automation",
    )
    op.add_column(
        "tenant_settings",
        sa.Column("whatsapp_ai_agent_profile_id", sa.UUID(), nullable=True),
        schema="crm",
    )
    op.add_column(
        "tenant_settings",
        sa.Column("whatsapp_ai_enabled_by_user_id", sa.UUID(), nullable=True),
        schema="crm",
    )
    op.add_column(
        "tenant_settings",
        sa.Column("whatsapp_ai_enabled_at", sa.DateTime(timezone=True), nullable=True),
        schema="crm",
    )
    op.create_foreign_key(
        "fk_tenant_settings_whatsapp_ai_agent",
        "tenant_settings",
        "agent_profiles",
        ["tenant_id", "whatsapp_ai_agent_profile_id"],
        ["tenant_id", "id"],
        source_schema="crm",
        referent_schema="agents",
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_tenant_settings_whatsapp_ai_actor",
        "tenant_settings",
        "users",
        ["whatsapp_ai_enabled_by_user_id"],
        ["id"],
        source_schema="crm",
        ondelete="RESTRICT",
    )
    op.create_check_constraint(
        "ck_tenant_settings_whatsapp_ai_shape",
        "tenant_settings",
        "(whatsapp_ai_agent_profile_id IS NULL AND "
        "whatsapp_ai_enabled_by_user_id IS NULL AND whatsapp_ai_enabled_at IS NULL) OR "
        "(whatsapp_ai_agent_profile_id IS NOT NULL AND "
        "whatsapp_ai_enabled_by_user_id IS NOT NULL AND whatsapp_ai_enabled_at IS NOT NULL)",
        schema="crm",
    )

    # Preserve the user's established profile while adopting the product-facing
    # name. A tenant that already has an AI Agent is left untouched.
    op.execute(
        sa.text(
            """
            UPDATE agents.agent_profiles profile
            SET name = 'AI Agent', updated_at = CURRENT_TIMESTAMP
            WHERE lower(profile.name) = lower('WhatsApp to Call Agent')
              AND profile.archived_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM agents.agent_profiles existing
                WHERE existing.tenant_id = profile.tenant_id
                  AND existing.id <> profile.id
                  AND existing.archived_at IS NULL
                  AND lower(existing.name) = lower('AI Agent')
              )
            """
        )
    )

    # Existing tenants that already built the named WhatsApp agent get a safe,
    # explicit default. The original author remains the authorization anchor and
    # is revalidated by the worker before every queued reply.
    op.execute(
        sa.text(
            """
            UPDATE crm.tenant_settings settings
            SET whatsapp_ai_agent_profile_id = candidate.profile_id,
                whatsapp_ai_enabled_by_user_id = candidate.actor_user_id,
                whatsapp_ai_enabled_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            FROM (
              SELECT DISTINCT ON (profile.tenant_id)
                     profile.tenant_id, profile.id AS profile_id,
                     member.user_id AS actor_user_id
              FROM agents.agent_profiles profile
              JOIN LATERAL (
                SELECT membership.user_id
                FROM memberships membership
                JOIN users account ON account.id = membership.user_id
                WHERE membership.tenant_id = profile.tenant_id
                  AND membership.role IN ('owner', 'admin', 'editor', 'agent')
                  AND account.status = 'active'
                ORDER BY CASE WHEN membership.user_id = profile.created_by_user_id THEN -1
                              ELSE 0 END,
                         CASE membership.role
                           WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                           WHEN 'editor' THEN 2 ELSE 3 END,
                         membership.created_at, membership.user_id
                LIMIT 1
              ) member ON true
              WHERE profile.archived_at IS NULL
                AND lower(profile.name) = lower('AI Agent')
                AND EXISTS (
                  SELECT 1 FROM agents.agent_profile_versions version
                  WHERE version.agent_profile_id = profile.id
                    AND version.published_at IS NOT NULL
                    AND version.validation_status = 'valid'
                    AND version.channel_capabilities @> ARRAY['whatsapp']::text[]
                )
              ORDER BY profile.tenant_id, profile.updated_at DESC, profile.id DESC
            ) candidate
            WHERE settings.tenant_id = candidate.tenant_id
              AND candidate.actor_user_id IS NOT NULL
              AND settings.whatsapp_ai_agent_profile_id IS NULL
            """
        )
    )

    # The worker needs only recipient identifiers; identity details remain
    # inaccessible to the messaging runtime role.
    op.execute(
        sa.text(
            """
            CREATE FUNCTION platform.current_tenant_notification_recipients()
            RETURNS TABLE(user_id uuid)
            LANGUAGE sql STABLE SECURITY DEFINER
            SET search_path = pg_catalog
            AS $$
              SELECT membership.user_id
              FROM public.memberships membership
              JOIN public.users account ON account.id = membership.user_id
              WHERE membership.tenant_id = platform.current_tenant_id()
                AND membership.role IN ('owner', 'admin', 'editor', 'agent')
                AND account.status = 'active'
            $$
            """
        )
    )
    op.execute(
        "REVOKE ALL ON FUNCTION platform.current_tenant_notification_recipients() FROM PUBLIC"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.current_tenant_notification_recipients() "
        "TO platform_messaging"
    )
    op.execute(
        "GRANT SELECT (tenant_id, whatsapp_ai_agent_profile_id, "
        "whatsapp_ai_enabled_by_user_id) "
        "ON crm.tenant_settings TO platform_messaging"
    )


def downgrade() -> None:
    op.execute(
        "REVOKE SELECT (tenant_id, whatsapp_ai_agent_profile_id, "
        "whatsapp_ai_enabled_by_user_id) "
        "ON crm.tenant_settings FROM platform_messaging"
    )
    op.execute("DROP FUNCTION platform.current_tenant_notification_recipients()")
    op.drop_constraint(
        "ck_tenant_settings_whatsapp_ai_shape",
        "tenant_settings",
        schema="crm",
        type_="check",
    )
    op.drop_constraint(
        "fk_tenant_settings_whatsapp_ai_actor",
        "tenant_settings",
        schema="crm",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_tenant_settings_whatsapp_ai_agent",
        "tenant_settings",
        schema="crm",
        type_="foreignkey",
    )
    op.drop_column("tenant_settings", "whatsapp_ai_enabled_at", schema="crm")
    op.drop_column("tenant_settings", "whatsapp_ai_enabled_by_user_id", schema="crm")
    op.drop_column("tenant_settings", "whatsapp_ai_agent_profile_id", schema="crm")
    op.drop_column("flow_definitions", "archived_at", schema="automation")
    op.drop_column("agent_profiles", "archived_at", schema="agents")
