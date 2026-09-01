"""add OpenLive PostgreSQL persistence

Revision ID: f5e8b540dfeb
Revises: cebe5f87cf18
Create Date: 2026-09-01 09:29:44.266389
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f5e8b540dfeb"
down_revision: str | None = "cebe5f87cf18"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chats",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("owner_user_id", sa.UUID(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False, server_default="New chat"),
        sa.Column("agent_id", sa.Text(), nullable=True),
        sa.Column("workspace_path", sa.Text(), nullable=True),
        sa.Column("external_session_id", sa.Text(), nullable=True),
        sa.Column("legacy_source_id", sa.Text(), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_live_chats_tenant_id_id"),
        schema="live",
    )
    op.create_index(
        "ix_live_chats_tenant_updated",
        "chats",
        ["tenant_id", sa.text("updated_at DESC"), sa.text("id DESC")],
        schema="live",
    )
    op.create_index(
        "uq_live_chats_legacy_source",
        "chats",
        ["tenant_id", "legacy_source_id"],
        unique=True,
        schema="live",
        postgresql_where=sa.text("legacy_source_id IS NOT NULL"),
    )

    op.create_table(
        "messages",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("chat_id", sa.UUID(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("legacy_source_id", sa.Text(), nullable=True),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("content", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("is_live", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("provider", sa.Text(), nullable=True),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "chat_id"],
            ["live.chats.tenant_id", "live.chats.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint("sequence >= 0", name="ck_live_message_sequence"),
        sa.CheckConstraint(
            "role IN ('user', 'assistant', 'system', 'tool', 'event')",
            name="ck_live_message_role",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(content) IN ('array', 'object')", name="ck_live_message_content"
        ),
        sa.UniqueConstraint("chat_id", "sequence", name="uq_live_message_chat_sequence"),
        schema="live",
    )
    op.create_index(
        "ix_live_messages_chat_cursor",
        "messages",
        ["tenant_id", "chat_id", sa.text("sequence DESC")],
        schema="live",
    )
    op.create_index(
        "uq_live_messages_legacy_source",
        "messages",
        ["tenant_id", "legacy_source_id"],
        unique=True,
        schema="live",
        postgresql_where=sa.text("legacy_source_id IS NOT NULL"),
    )

    op.create_table(
        "user_preferences",
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("source", sa.Text(), nullable=False, server_default="server"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id", "tenant_id"],
            ["memberships.user_id", "memberships.tenant_id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "source IN ('server', 'browser_export', 'legacy_import')",
            name="ck_live_preference_source",
        ),
        sa.PrimaryKeyConstraint("tenant_id", "user_id", "key"),
        schema="live",
    )

    op.create_table(
        "provider_configurations",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("owner_user_id", sa.UUID(), nullable=True),
        sa.Column("provider_kind", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("credential_id", sa.UUID(), nullable=True),
        sa.Column("display_hint", sa.Text(), nullable=True),
        sa.Column(
            "settings",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "credential_id"],
            ["platform.credential_records.tenant_id", "platform.credential_records.id"],
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "NOT (settings ?| ARRAY['apiKey', 'api_key', 'token', 'access_token', "
            "'secret', 'password'])",
            name="ck_live_provider_settings_no_secret_keys",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_live_provider_configs_tenant_id_id"),
        schema="live",
    )
    op.create_index(
        "uq_live_provider_config_scope_name",
        "provider_configurations",
        [
            "tenant_id",
            sa.text("COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid)"),
            "provider_kind",
            "name",
        ],
        unique=True,
        schema="live",
    )
    op.create_index(
        "uq_live_provider_default_scope",
        "provider_configurations",
        [
            "tenant_id",
            sa.text("COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid)"),
            "provider_kind",
        ],
        unique=True,
        schema="live",
        postgresql_where=sa.text("is_default"),
    )

    op.create_table(
        "voice_profiles",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("owner_user_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("transcript", sa.Text(), nullable=True),
        sa.Column("object_id", sa.UUID(), nullable=True),
        sa.Column("duration_seconds", sa.Numeric(10, 3), nullable=True),
        sa.Column("source_kind", sa.Text(), nullable=False, server_default="legacy_import"),
        sa.Column("consent_recorded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "object_id"],
            ["objects.object_metadata.tenant_id", "objects.object_metadata.id"],
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds >= 0",
            name="ck_live_voice_duration",
        ),
        sa.CheckConstraint(
            "source_kind IN ('recorded', 'uploaded', 'legacy_import')",
            name="ck_live_voice_source_kind",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_live_voice_profiles_tenant_id_id"),
        sa.UniqueConstraint(
            "tenant_id", "owner_user_id", "name", name="uq_live_voice_profile_name"
        ),
        schema="live",
    )
    op.create_index(
        "ix_live_voice_profiles_owner_created",
        "voice_profiles",
        ["tenant_id", "owner_user_id", sa.text("created_at DESC")],
        schema="live",
    )

    op.create_table(
        "sessions",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("chat_id", sa.UUID(), nullable=False),
        sa.Column("owner_user_id", sa.UUID(), nullable=True),
        sa.Column("model_configuration_id", sa.UUID(), nullable=True),
        sa.Column("external_session_id", sa.Text(), nullable=True),
        sa.Column("agent_reference", sa.Text(), nullable=True),
        sa.Column("mode", sa.Text(), nullable=False, server_default="chat"),
        sa.Column("status", sa.Text(), nullable=False, server_default="created"),
        sa.Column(
            "settings",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["tenant_id", "chat_id"],
            ["live.chats.tenant_id", "live.chats.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "model_configuration_id"],
            ["agents.model_configurations.tenant_id", "agents.model_configurations.id"],
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "mode IN ('chat', 'voice', 'camera', 'screen')", name="ck_live_session_mode"
        ),
        sa.CheckConstraint(
            "status IN ('created', 'active', 'completed', 'failed', 'cancelled')",
            name="ck_live_session_status",
        ),
        sa.CheckConstraint(
            "ended_at IS NULL OR ended_at >= started_at", name="ck_live_session_time"
        ),
        schema="live",
    )
    op.create_index(
        "ix_live_sessions_tenant_status_started",
        "sessions",
        ["tenant_id", "status", sa.text("started_at DESC"), sa.text("id DESC")],
        schema="live",
    )
    op.create_index(
        "uq_live_sessions_external_id",
        "sessions",
        ["tenant_id", "external_session_id"],
        unique=True,
        schema="live",
        postgresql_where=sa.text("external_session_id IS NOT NULL"),
    )

    for table in (
        "chats",
        "messages",
        "user_preferences",
        "provider_configurations",
        "voice_profiles",
        "sessions",
    ):
        qualified = f'"live"."{table}"'
        op.execute(sa.text(f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY"))
        op.execute(sa.text(f"ALTER TABLE {qualified} FORCE ROW LEVEL SECURITY"))
        op.execute(
            sa.text(
                f"CREATE POLICY {table}_tenant_isolation ON {qualified} "
                "USING (tenant_id = platform.current_tenant_id()) "
                "WITH CHECK (tenant_id = platform.current_tenant_id())"
            )
        )

    for role in ("platform_web", "platform_worker", "platform_readonly"):
        op.execute(sa.text(f'GRANT USAGE ON SCHEMA live TO "{role}"'))
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA live "
        "TO platform_web, platform_worker"
    )
    op.execute("GRANT SELECT ON ALL TABLES IN SCHEMA live TO platform_readonly")


def downgrade() -> None:
    for table in (
        "sessions",
        "voice_profiles",
        "provider_configurations",
        "user_preferences",
        "messages",
        "chats",
    ):
        op.drop_table(table, schema="live")
