"""Add the canonical tenant-scoped CRM foundation.

Revision ID: a929e3f55c7a
Revises: 34376836baf5
Create Date: 2026-09-01 09:12:10.023880
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a929e3f55c7a"
down_revision: str | None = "34376836baf5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tenant_settings",
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("display_name", sa.Text(), nullable=True),
        sa.Column("default_currency", sa.String(length=3), nullable=False, server_default="USD"),
        sa.Column("locale", sa.Text(), nullable=False, server_default="en"),
        sa.Column("timezone", sa.Text(), nullable=False, server_default="UTC"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint("default_currency ~ '^[A-Z]{3}$'", name="ck_tenant_currency_iso"),
        schema="crm",
    )

    op.create_table(
        "contacts",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column("assigned_user_id", sa.UUID(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("company", sa.Text(), nullable=True),
        sa.Column("lifecycle_status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "lifecycle_status IN ('active', 'archived', 'blocked')",
            name="ck_contacts_lifecycle_status",
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["assigned_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_contacts_tenant_id_id"),
        schema="crm",
    )
    op.create_index(
        "ix_contacts_tenant_activity",
        "contacts",
        ["tenant_id", sa.text("last_activity_at DESC"), sa.text("id DESC")],
        schema="crm",
    )
    op.create_index(
        "ix_contacts_tenant_name",
        "contacts",
        ["tenant_id", sa.text("lower(name)")],
        schema="crm",
    )

    op.create_table(
        "contact_channel_identities",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("normalized_value", sa.Text(), nullable=True),
        sa.Column("display_value", sa.Text(), nullable=True),
        sa.Column("value_ciphertext", sa.Text(), nullable=True),
        sa.Column("value_blind_index", sa.Text(), nullable=True),
        sa.Column("provider", sa.Text(), nullable=True),
        sa.Column("provider_identity_id", sa.Text(), nullable=True),
        sa.Column("validation_status", sa.Text(), nullable=False, server_default="unverified"),
        sa.Column("is_primary", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "channel IN ('phone', 'whatsapp', 'email', 'sip', 'external')",
            name="ck_contact_identity_channel",
        ),
        sa.CheckConstraint(
            "validation_status IN ('unverified', 'valid', 'invalid', 'revoked')",
            name="ck_contact_identity_validation",
        ),
        sa.CheckConstraint(
            "normalized_value IS NOT NULL OR value_blind_index IS NOT NULL",
            name="ck_contact_identity_lookup_value",
        ),
        sa.CheckConstraint(
            "channel NOT IN ('phone', 'whatsapp') OR normalized_value IS NULL "
            "OR normalized_value ~ '^\\+[1-9][0-9]{7,14}$'",
            name="ck_contact_identity_e164",
        ),
        schema="crm",
    )
    op.create_index(
        "uq_contact_identity_normalized",
        "contact_channel_identities",
        ["tenant_id", "channel", "normalized_value"],
        unique=True,
        schema="crm",
        postgresql_where=sa.text("normalized_value IS NOT NULL"),
    )
    op.create_index(
        "uq_contact_identity_blind",
        "contact_channel_identities",
        ["tenant_id", "channel", "value_blind_index"],
        unique=True,
        schema="crm",
        postgresql_where=sa.text("value_blind_index IS NOT NULL"),
    )
    op.create_index(
        "uq_contact_identity_provider",
        "contact_channel_identities",
        ["tenant_id", "provider", "provider_identity_id"],
        unique=True,
        schema="crm",
        postgresql_where=sa.text("provider IS NOT NULL AND provider_identity_id IS NOT NULL"),
    )

    op.create_table(
        "tags",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("color", sa.Text(), nullable=False, server_default="#64748b"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_tags_tenant_id_id"),
        schema="crm",
    )
    op.create_index(
        "uq_tags_tenant_name",
        "tags",
        ["tenant_id", sa.text("lower(name)")],
        unique=True,
        schema="crm",
    )
    op.create_table(
        "contact_tags",
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=False),
        sa.Column("tag_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "tag_id"], ["crm.tags.tenant_id", "crm.tags.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("tenant_id", "contact_id", "tag_id"),
        schema="crm",
    )
    op.create_index(
        "ix_contact_tags_tag_contact",
        "contact_tags",
        ["tenant_id", "tag_id", "contact_id"],
        schema="crm",
    )

    op.create_table(
        "custom_field_definitions",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("field_type", sa.Text(), nullable=False),
        sa.Column("options", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "field_type IN ('text', 'number', 'date', 'boolean', 'select', 'multi_select')",
            name="ck_custom_field_type",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_custom_fields_tenant_id_id"),
        sa.UniqueConstraint("tenant_id", "key", name="uq_custom_fields_tenant_key"),
        schema="crm",
    )
    op.create_table(
        "contact_custom_field_values",
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=False),
        sa.Column("field_id", sa.UUID(), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "field_id"],
            ["crm.custom_field_definitions.tenant_id", "crm.custom_field_definitions.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("tenant_id", "contact_id", "field_id"),
        schema="crm",
    )

    op.create_table(
        "notes",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=False),
        sa.Column("author_user_id", sa.UUID(), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["author_user_id"], ["users.id"], ondelete="SET NULL"),
        schema="crm",
    )
    op.create_index(
        "ix_notes_contact_time",
        "notes",
        ["tenant_id", "contact_id", sa.text("created_at DESC"), sa.text("id DESC")],
        schema="crm",
    )

    op.create_table(
        "pipelines",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id", sa.UUID(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_pipelines_tenant_id_id"),
        schema="crm",
    )
    op.create_index(
        "uq_pipelines_tenant_name",
        "pipelines",
        ["tenant_id", sa.text("lower(name)")],
        unique=True,
        schema="crm",
    )
    op.create_index(
        "uq_pipelines_one_default",
        "pipelines",
        ["tenant_id"],
        unique=True,
        schema="crm",
        postgresql_where=sa.text("is_default"),
    )

    op.create_table(
        "pipeline_stages",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("pipeline_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("probability", sa.Integer(), nullable=False, server_default="0"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "pipeline_id"],
            ["crm.pipelines.tenant_id", "crm.pipelines.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint("position >= 0", name="ck_pipeline_stage_position"),
        sa.CheckConstraint("probability BETWEEN 0 AND 100", name="ck_pipeline_stage_probability"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_pipeline_stages_tenant_id_id"),
        sa.UniqueConstraint(
            "tenant_id",
            "pipeline_id",
            "id",
            name="uq_pipeline_stages_tenant_pipeline_id",
        ),
        sa.UniqueConstraint("pipeline_id", "position", name="uq_pipeline_stage_position"),
        schema="crm",
    )

    op.create_table(
        "deals",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("pipeline_id", sa.UUID(), nullable=False),
        sa.Column("stage_id", sa.UUID(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=True),
        sa.Column("owner_user_id", sa.UUID(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("value", sa.Numeric(precision=18, scale=2), nullable=False, server_default="0"),
        sa.Column("currency", sa.String(length=3), nullable=False, server_default="USD"),
        sa.Column("status", sa.Text(), nullable=False, server_default="open"),
        sa.Column("expected_close_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
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
            ["tenant_id", "pipeline_id"],
            ["crm.pipelines.tenant_id", "crm.pipelines.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "pipeline_id", "stage_id"],
            [
                "crm.pipeline_stages.tenant_id",
                "crm.pipeline_stages.pipeline_id",
                "crm.pipeline_stages.id",
            ],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint("value >= 0", name="ck_deal_value_nonnegative"),
        sa.CheckConstraint("currency ~ '^[A-Z]{3}$'", name="ck_deal_currency_iso"),
        sa.CheckConstraint("status IN ('open', 'won', 'lost', 'archived')", name="ck_deal_status"),
        schema="crm",
    )
    op.create_index(
        "ix_deals_tenant_stage_status",
        "deals",
        ["tenant_id", "pipeline_id", "stage_id", "status"],
        schema="crm",
    )
    op.create_index(
        "ix_deals_contact_time",
        "deals",
        ["tenant_id", "contact_id", sa.text("updated_at DESC"), sa.text("id DESC")],
        schema="crm",
    )

    tenant_tables = (
        "tenant_settings",
        "contacts",
        "contact_channel_identities",
        "tags",
        "contact_tags",
        "custom_field_definitions",
        "contact_custom_field_values",
        "notes",
        "pipelines",
        "pipeline_stages",
        "deals",
    )
    for table in tenant_tables:
        qualified = f'crm."{table}"'
        op.execute(sa.text(f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY"))
        op.execute(sa.text(f"ALTER TABLE {qualified} FORCE ROW LEVEL SECURITY"))
        op.execute(
            sa.text(
                f"CREATE POLICY {table}_tenant_isolation ON {qualified} "
                "USING (tenant_id = platform.current_tenant_id()) "
                "WITH CHECK (tenant_id = platform.current_tenant_id())"
            )
        )

    for role in ("platform_web", "platform_messaging", "platform_voice", "platform_readonly"):
        op.execute(sa.text(f'GRANT USAGE ON SCHEMA crm TO "{role}"'))
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA crm TO platform_web")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON crm.contacts, "
        "crm.contact_channel_identities TO platform_messaging"
    )
    op.execute("GRANT SELECT ON crm.contacts, crm.contact_channel_identities TO platform_voice")
    op.execute("GRANT SELECT ON ALL TABLES IN SCHEMA crm TO platform_readonly")


def downgrade() -> None:
    for table in (
        "deals",
        "pipeline_stages",
        "pipelines",
        "notes",
        "contact_custom_field_values",
        "custom_field_definitions",
        "contact_tags",
        "tags",
        "contact_channel_identities",
        "contacts",
        "tenant_settings",
    ):
        op.drop_table(table, schema="crm")
