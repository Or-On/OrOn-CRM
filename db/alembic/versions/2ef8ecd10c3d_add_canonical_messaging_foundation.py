"""Add canonical messaging, template, and broadcast persistence.

Revision ID: 2ef8ecd10c3d
Revises: a929e3f55c7a
Create Date: 2026-09-01 09:14:54.746497
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "2ef8ecd10c3d"
down_revision: str | None = "a929e3f55c7a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_credential_records_tenant_id_id",
        "credential_records",
        ["tenant_id", "id"],
        schema="platform",
    )
    op.create_unique_constraint(
        "uq_platform_campaigns_tenant_id_id",
        "campaigns",
        ["tenant_id", "id"],
        schema="platform",
    )

    op.create_table(
        "channels",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_account_id", sa.Text(), nullable=True),
        sa.Column("display_address", sa.Text(), nullable=True),
        sa.Column("credential_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="disabled"),
        sa.Column("mirror_inbound_media", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "configuration",
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
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "credential_id"],
            ["platform.credential_records.tenant_id", "platform.credential_records.id"],
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "kind IN ('whatsapp', 'sms', 'email', 'webchat')", name="ck_channel_kind"
        ),
        sa.CheckConstraint(
            "status IN ('disabled', 'active', 'degraded', 'revoked')", name="ck_channel_status"
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_channels_tenant_id_id"),
        schema="messaging",
    )
    op.create_index(
        "uq_channels_provider_account",
        "channels",
        ["provider", "provider_account_id"],
        unique=True,
        schema="messaging",
        postgresql_where=sa.text("provider_account_id IS NOT NULL"),
    )

    op.create_table(
        "conversations",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=False),
        sa.Column("assigned_user_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="open"),
        sa.Column("unread_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_message_preview", sa.Text(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["tenant_id", "channel_id"],
            ["messaging.channels.tenant_id", "messaging.channels.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["assigned_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint(
            "status IN ('open', 'pending', 'resolved', 'closed')", name="ck_conversation_status"
        ),
        sa.CheckConstraint("unread_count >= 0", name="ck_conversation_unread_nonnegative"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_conversations_tenant_id_id"),
        sa.UniqueConstraint(
            "tenant_id", "channel_id", "contact_id", name="uq_conversation_channel_contact"
        ),
        schema="messaging",
    )
    op.create_index(
        "ix_conversations_inbox",
        "conversations",
        ["tenant_id", "status", sa.text("last_message_at DESC"), sa.text("id DESC")],
        schema="messaging",
    )
    op.create_index(
        "ix_conversations_assignee_unread",
        "conversations",
        ["tenant_id", "assigned_user_id", "unread_count"],
        schema="messaging",
        postgresql_where=sa.text("unread_count > 0"),
    )

    op.create_table(
        "conversation_participants",
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.UUID(), nullable=False),
        sa.Column("participant_type", sa.Text(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=True),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "conversation_id"],
            ["messaging.conversations.tenant_id", "messaging.conversations.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "participant_type IN ('contact', 'user', 'service')",
            name="ck_conversation_participant_type",
        ),
        sa.CheckConstraint(
            "(participant_type = 'contact' AND contact_id IS NOT NULL "
            "AND user_id IS NULL) OR (participant_type = 'user' "
            "AND user_id IS NOT NULL AND contact_id IS NULL) OR "
            "(participant_type = 'service' AND contact_id IS NULL "
            "AND user_id IS NULL)",
            name="ck_conversation_participant_reference",
        ),
        schema="messaging",
    )
    op.create_index(
        "uq_conversation_participant_contact",
        "conversation_participants",
        ["tenant_id", "conversation_id", "contact_id"],
        unique=True,
        schema="messaging",
        postgresql_where=sa.text("participant_type = 'contact'"),
    )
    op.create_index(
        "uq_conversation_participant_user",
        "conversation_participants",
        ["tenant_id", "conversation_id", "user_id"],
        unique=True,
        schema="messaging",
        postgresql_where=sa.text("participant_type = 'user'"),
    )
    op.create_index(
        "uq_conversation_participant_service",
        "conversation_participants",
        ["tenant_id", "conversation_id", "participant_type"],
        unique=True,
        schema="messaging",
        postgresql_where=sa.text("participant_type = 'service'"),
    )

    op.create_table(
        "messages",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.UUID(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("sender_type", sa.Text(), nullable=False),
        sa.Column("sender_user_id", sa.UUID(), nullable=True),
        sa.Column("sender_contact_id", sa.UUID(), nullable=True),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("content_text", sa.Text(), nullable=True),
        sa.Column("structured_content", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("object_id", sa.UUID(), nullable=True),
        sa.Column("provider", sa.Text(), nullable=True),
        sa.Column("provider_message_id", sa.Text(), nullable=True),
        sa.Column("reply_to_message_id", sa.UUID(), nullable=True),
        sa.Column("interactive_reply_id", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("provider_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["tenant_id", "conversation_id"],
            ["messaging.conversations.tenant_id", "messaging.conversations.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["sender_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "sender_contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["reply_to_message_id"], ["messaging.messages.id"], ondelete="SET NULL"
        ),
        sa.CheckConstraint(
            "direction IN ('inbound', 'outbound', 'internal')", name="ck_message_direction"
        ),
        sa.CheckConstraint(
            "sender_type IN ('contact', 'user', 'agent', 'system')", name="ck_message_sender_type"
        ),
        sa.CheckConstraint(
            "content_type IN ('text', 'image', 'document', 'audio', 'video', "
            "'location', 'template', 'interactive', 'event')",
            name="ck_message_content_type",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'received')",
            name="ck_message_status",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_messages_tenant_id_id"),
        schema="messaging",
    )
    op.create_index(
        "ix_messages_conversation_cursor",
        "messages",
        ["tenant_id", "conversation_id", sa.text("created_at DESC"), sa.text("id DESC")],
        schema="messaging",
    )
    op.create_index(
        "uq_messages_provider_id",
        "messages",
        ["tenant_id", "provider", "provider_message_id"],
        unique=True,
        schema="messaging",
        postgresql_where=sa.text("provider IS NOT NULL AND provider_message_id IS NOT NULL"),
    )

    op.create_table(
        "message_delivery_events",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.UUID(), nullable=False),
        sa.Column("provider_event_id", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "message_id"],
            ["messaging.messages.tenant_id", "messaging.messages.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'received')",
            name="ck_delivery_event_status",
        ),
        schema="messaging",
    )
    op.create_index(
        "uq_delivery_provider_event",
        "message_delivery_events",
        ["tenant_id", "provider_event_id"],
        unique=True,
        schema="messaging",
        postgresql_where=sa.text("provider_event_id IS NOT NULL"),
    )

    op.create_table(
        "message_reactions",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.UUID(), nullable=False),
        sa.Column("actor_type", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=True),
        sa.Column("emoji", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "message_id"],
            ["messaging.messages.tenant_id", "messaging.messages.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "actor_type IN ('contact', 'user', 'agent')", name="ck_reaction_actor_type"
        ),
        sa.UniqueConstraint(
            "tenant_id", "message_id", "actor_type", "actor_id", name="uq_message_reaction_actor"
        ),
        schema="messaging",
    )

    op.create_table(
        "message_templates",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("language", sa.Text(), nullable=False),
        sa.Column("category", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="draft"),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("components", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("provider_template_id", sa.Text(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["tenant_id", "channel_id"],
            ["messaging.channels.tenant_id", "messaging.channels.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'pending', 'approved', 'rejected', 'paused', 'disabled')",
            name="ck_message_template_status",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_message_templates_tenant_id_id"),
        sa.UniqueConstraint(
            "tenant_id", "channel_id", "name", "language", name="uq_message_template_name_language"
        ),
        schema="messaging",
    )
    op.create_index(
        "uq_message_template_provider",
        "message_templates",
        ["tenant_id", "channel_id", "provider_template_id"],
        unique=True,
        schema="messaging",
        postgresql_where=sa.text("provider_template_id IS NOT NULL"),
    )

    op.create_table(
        "quick_replies",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("shortcut", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        schema="messaging",
    )
    op.create_index(
        "uq_quick_reply_shortcut",
        "quick_replies",
        ["tenant_id", sa.text("lower(shortcut)")],
        unique=True,
        schema="messaging",
        postgresql_where=sa.text("shortcut IS NOT NULL"),
    )

    op.create_table(
        "broadcasts",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("campaign_id", sa.UUID(), nullable=False),
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("template_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="draft"),
        sa.Column("total_recipients", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sent_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("delivered_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("read_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("replied_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("delivery_locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivery_locked_by", sa.Text(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["tenant_id", "campaign_id"],
            ["platform.campaigns.tenant_id", "platform.campaigns.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "channel_id"],
            ["messaging.channels.tenant_id", "messaging.channels.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "template_id"],
            ["messaging.message_templates.tenant_id", "messaging.message_templates.id"],
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'failed', 'cancelled')",
            name="ck_broadcast_status",
        ),
        sa.CheckConstraint(
            "total_recipients >= 0 AND sent_count >= 0 AND delivered_count >= 0 "
            "AND read_count >= 0 AND replied_count >= 0 AND failed_count >= 0",
            name="ck_broadcast_counts_nonnegative",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_broadcasts_tenant_id_id"),
        schema="messaging",
    )
    op.create_index(
        "ix_broadcasts_claim",
        "broadcasts",
        ["tenant_id", "status", "delivery_locked_at", "id"],
        schema="messaging",
    )

    op.create_table(
        "broadcast_recipients",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("broadcast_id", sa.UUID(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column(
            "template_params",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("provider_message_id", sa.Text(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error_safe", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("replied_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "broadcast_id"],
            ["messaging.broadcasts.tenant_id", "messaging.broadcasts.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'sent', 'delivered', 'read', 'replied', 'failed')",
            name="ck_broadcast_recipient_status",
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_broadcast_recipient_attempts"),
        sa.UniqueConstraint(
            "tenant_id", "broadcast_id", "contact_id", name="uq_broadcast_recipient_contact"
        ),
        schema="messaging",
    )
    op.create_index(
        "ix_broadcast_recipients_pending",
        "broadcast_recipients",
        ["tenant_id", "broadcast_id", "status", "created_at", "id"],
        schema="messaging",
    )
    op.create_index(
        "uq_broadcast_recipient_provider_message",
        "broadcast_recipients",
        ["tenant_id", "provider_message_id"],
        unique=True,
        schema="messaging",
        postgresql_where=sa.text("provider_message_id IS NOT NULL"),
    )

    op.create_table(
        "notifications",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("reference_type", sa.Text(), nullable=True),
        sa.Column("reference_id", sa.UUID(), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        schema="messaging",
    )
    op.create_index(
        "ix_notifications_user_unread",
        "notifications",
        ["tenant_id", "user_id", sa.text("created_at DESC"), sa.text("id DESC")],
        schema="messaging",
        postgresql_where=sa.text("read_at IS NULL"),
    )

    op.execute(
        """
        CREATE FUNCTION messaging.adjust_broadcast_counts()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog
        AS $$
        DECLARE
          target_id uuid := COALESCE(NEW.broadcast_id, OLD.broadcast_id);
          old_status text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END;
          new_status text := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.status END;
        BEGIN
          UPDATE messaging.broadcasts
          SET sent_count = GREATEST(
                0, sent_count + COALESCE((new_status = 'sent')::int, 0)
                - COALESCE((old_status = 'sent')::int, 0)),
              delivered_count = GREATEST(
                0, delivered_count + COALESCE((new_status = 'delivered')::int, 0)
                - COALESCE((old_status = 'delivered')::int, 0)),
              read_count = GREATEST(
                0, read_count + COALESCE((new_status = 'read')::int, 0)
                - COALESCE((old_status = 'read')::int, 0)),
              replied_count = GREATEST(
                0, replied_count + COALESCE((new_status = 'replied')::int, 0)
                - COALESCE((old_status = 'replied')::int, 0)),
              failed_count = GREATEST(
                0, failed_count + COALESCE((new_status = 'failed')::int, 0)
                - COALESCE((old_status = 'failed')::int, 0)),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = target_id;
          RETURN COALESCE(NEW, OLD);
        END
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION messaging.adjust_broadcast_counts() FROM PUBLIC")
    op.execute(
        "CREATE TRIGGER trg_adjust_broadcast_counts AFTER INSERT OR DELETE "
        "OR UPDATE OF status ON messaging.broadcast_recipients FOR EACH ROW "
        "EXECUTE FUNCTION messaging.adjust_broadcast_counts()"
    )

    tenant_tables = (
        "channels",
        "conversations",
        "conversation_participants",
        "messages",
        "message_delivery_events",
        "message_reactions",
        "message_templates",
        "quick_replies",
        "broadcasts",
        "broadcast_recipients",
        "notifications",
    )
    for table in tenant_tables:
        qualified = f'messaging."{table}"'
        op.execute(sa.text(f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY"))
        op.execute(sa.text(f"ALTER TABLE {qualified} FORCE ROW LEVEL SECURITY"))
        op.execute(
            sa.text(
                f"CREATE POLICY {table}_tenant_isolation ON {qualified} "
                "USING (tenant_id = platform.current_tenant_id()) "
                "WITH CHECK (tenant_id = platform.current_tenant_id())"
            )
        )

    for role in ("platform_web", "platform_messaging", "platform_worker", "platform_readonly"):
        op.execute(sa.text(f'GRANT USAGE ON SCHEMA messaging TO "{role}"'))
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA messaging TO platform_web"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA messaging "
        "TO platform_messaging"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON messaging.broadcasts, "
        "messaging.broadcast_recipients TO platform_worker"
    )
    op.execute("GRANT SELECT ON ALL TABLES IN SCHEMA messaging TO platform_readonly")


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS trg_adjust_broadcast_counts ON messaging.broadcast_recipients"
    )
    op.execute("DROP FUNCTION IF EXISTS messaging.adjust_broadcast_counts()")
    for table in (
        "notifications",
        "broadcast_recipients",
        "broadcasts",
        "quick_replies",
        "message_templates",
        "message_reactions",
        "message_delivery_events",
        "messages",
        "conversation_participants",
        "conversations",
        "channels",
    ):
        op.drop_table(table, schema="messaging")
    op.drop_constraint(
        "uq_platform_campaigns_tenant_id_id", "campaigns", schema="platform", type_="unique"
    )
    op.drop_constraint(
        "uq_credential_records_tenant_id_id",
        "credential_records",
        schema="platform",
        type_="unique",
    )
