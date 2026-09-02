"""add real whatsapp delivery foundation

Revision ID: a1a71d1f7a03
Revises: bc63218e8d41
Create Date: 2026-09-02 18:12:35.796408
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a1a71d1f7a03"
down_revision: str | None = "bc63218e8d41"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "contacts",
        sa.Column("whatsapp_consent", sa.Text(), nullable=False, server_default="unknown"),
        schema="crm",
    )
    op.add_column(
        "contacts",
        sa.Column("whatsapp_opted_out_at", sa.DateTime(timezone=True), nullable=True),
        schema="crm",
    )
    op.create_check_constraint(
        "ck_contacts_whatsapp_consent",
        "contacts",
        "whatsapp_consent IN ('unknown', 'granted', 'revoked')",
        schema="crm",
    )
    op.create_unique_constraint(
        "uq_contact_channel_identities_tenant_id_id",
        "contact_channel_identities",
        ["tenant_id", "id"],
        schema="crm",
    )
    op.create_index(
        "ix_contacts_whatsapp_eligibility",
        "contacts",
        ["tenant_id", "whatsapp_consent", "lifecycle_status", "id"],
        schema="crm",
        postgresql_where=sa.text("whatsapp_opted_out_at IS NULL"),
    )
    op.add_column(
        "conversations",
        sa.Column("customer_service_window_expires_at", sa.DateTime(timezone=True), nullable=True),
        schema="messaging",
    )
    op.create_index(
        "ix_conversations_customer_service_window",
        "conversations",
        ["tenant_id", "customer_service_window_expires_at"],
        schema="messaging",
        postgresql_where=sa.text("customer_service_window_expires_at IS NOT NULL"),
    )
    op.create_check_constraint(
        "ck_channels_configuration_has_no_secrets",
        "channels",
        "NOT (configuration ?| ARRAY['access_token','app_secret','webhook_verify_token',"
        "'token','secret','password','private_key'])",
        schema="messaging",
    )
    op.create_table(
        "outbound_requests",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.UUID(), nullable=False),
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("recipient_identity_id", sa.UUID(), nullable=False),
        sa.Column("requested_by_user_id", sa.UUID(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("message_kind", sa.Text(), nullable=False),
        sa.Column("template_name", sa.Text(), nullable=True),
        sa.Column("template_language", sa.Text(), nullable=True),
        sa.Column("template_parameters", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("explicitly_confirmed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("last_error_code", sa.Text(), nullable=True),
        sa.Column("provider_message_id", sa.Text(), nullable=True),
        sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "conversation_id"],
            ["messaging.conversations.tenant_id", "messaging.conversations.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "message_id"],
            ["messaging.messages.tenant_id", "messaging.messages.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "channel_id"],
            ["messaging.channels.tenant_id", "messaging.channels.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "recipient_identity_id"],
            ["crm.contact_channel_identities.tenant_id", "crm.contact_channel_identities.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["requested_by_user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.CheckConstraint(
            "provider IN ('simulator', 'meta')", name="ck_outbound_request_provider"
        ),
        sa.CheckConstraint("message_kind IN ('text', 'template')", name="ck_outbound_request_kind"),
        sa.CheckConstraint(
            "(message_kind = 'text' AND template_name IS NULL AND template_language IS NULL) OR "
            "(message_kind = 'template' AND template_name IS NOT NULL "
            "AND template_language IS NOT NULL)",
            name="ck_outbound_request_template_shape",
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed')",
            name="ck_outbound_request_status",
        ),
        sa.CheckConstraint(
            "provider <> 'meta' OR explicitly_confirmed",
            name="ck_real_outbound_explicit_confirmation",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_outbound_requests_tenant_id_id"),
        sa.UniqueConstraint("tenant_id", "idempotency_key", name="uq_outbound_request_idempotency"),
        sa.UniqueConstraint("tenant_id", "message_id", name="uq_outbound_request_message"),
        schema="messaging",
    )
    op.create_index(
        "ix_outbound_requests_status",
        "outbound_requests",
        ["tenant_id", "status", "created_at", "id"],
        schema="messaging",
    )
    op.create_index(
        "uq_outbound_requests_provider_message",
        "outbound_requests",
        ["tenant_id", "provider", "provider_message_id"],
        unique=True,
        schema="messaging",
        postgresql_where=sa.text("provider_message_id IS NOT NULL"),
    )
    op.execute("ALTER TABLE messaging.outbound_requests ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE messaging.outbound_requests FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY outbound_requests_tenant_isolation ON messaging.outbound_requests "
        "USING (tenant_id = platform.current_tenant_id()) "
        "WITH CHECK (tenant_id = platform.current_tenant_id())"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON messaging.outbound_requests "
        "TO platform_web, platform_messaging"
    )


def downgrade() -> None:
    op.execute(
        "REVOKE SELECT, INSERT, UPDATE ON messaging.outbound_requests "
        "FROM platform_web, platform_messaging"
    )
    op.drop_table("outbound_requests", schema="messaging")
    op.drop_constraint(
        "uq_contact_channel_identities_tenant_id_id",
        "contact_channel_identities",
        schema="crm",
        type_="unique",
    )
    op.drop_constraint(
        "ck_channels_configuration_has_no_secrets", "channels", schema="messaging", type_="check"
    )
    op.drop_index(
        "ix_conversations_customer_service_window", table_name="conversations", schema="messaging"
    )
    op.drop_column("conversations", "customer_service_window_expires_at", schema="messaging")
    op.drop_index("ix_contacts_whatsapp_eligibility", table_name="contacts", schema="crm")
    op.drop_constraint("ck_contacts_whatsapp_consent", "contacts", schema="crm", type_="check")
    op.drop_column("contacts", "whatsapp_opted_out_at", schema="crm")
    op.drop_column("contacts", "whatsapp_consent", schema="crm")
