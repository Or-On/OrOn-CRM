"""Add the canonical tenant-scoped lead capture domain.

A lead is commercial interest with a qualification lifecycle. It is deliberately
neither a contact (the person and their channel associations), a deal (a sales
opportunity progressing through a pipeline) nor a ticket (a support issue), and
it never borrows those tables: a lead that is "resolved" or a ticket that has a
budget are both category errors that corrupt reporting.

Field values are append-only. A correction supersedes its predecessor rather
than overwriting it, so a later human verification can always be distinguished
from an earlier provisional extraction, and "unknown", "declined" and "not
applicable" stay distinguishable from a stored empty string.

Revision ID: c7a41d6e9b52
Revises: b8d5e21f7a04
Create Date: 2026-09-19 10:41:02.114503
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c7a41d6e9b52"
down_revision: str | None = "b8d5e21f7a04"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TENANT_TABLES = ("lead_field_schemas", "leads", "lead_field_values", "lead_operations")


def _tenant_policy(table: str) -> None:
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


def upgrade() -> None:
    op.create_table(
        "lead_field_schemas",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "definition",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint("version >= 1", name="ck_lead_field_schema_version_positive"),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_lead_field_schema_name_nonempty"),
        sa.CheckConstraint(
            "jsonb_typeof(definition) = 'array'", name="ck_lead_field_schema_definition_array"
        ),
        # A schema is a reviewable contract, not an open bag: publication freezes
        # a bounded list so a prompt cannot silently widen it per conversation.
        sa.CheckConstraint(
            "jsonb_array_length(definition) <= 40", name="ck_lead_field_schema_definition_bounded"
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_lead_field_schemas_tenant_id_id"),
        schema="crm",
    )
    op.create_index(
        "uq_lead_field_schema_name_version",
        "lead_field_schemas",
        ["tenant_id", sa.text("lower(name)"), "version"],
        unique=True,
        schema="crm",
    )

    op.create_table(
        "leads",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("reference", sa.Text(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=False),
        sa.Column("source_channel", sa.Text(), nullable=False),
        sa.Column("source_conversation_id", sa.UUID(), nullable=True),
        sa.Column("source_message_id", sa.UUID(), nullable=True),
        sa.Column("source_session_id", sa.UUID(), nullable=True),
        sa.Column("handoff_id", sa.UUID(), nullable=True),
        sa.Column("agent_profile_version_id", sa.UUID(), nullable=True),
        sa.Column("field_schema_id", sa.UUID(), nullable=True),
        sa.Column("field_schema_version", sa.Integer(), nullable=True),
        sa.Column("business_objective", sa.Text(), nullable=True),
        # Two genuinely different commercial interests from one person are two
        # leads. This key is what keeps them apart while still de-duplicating a
        # redelivered webhook for the same interest.
        sa.Column("interest_key", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="new"),
        sa.Column("owner_user_id", sa.UUID(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("next_action", sa.Text(), nullable=True),
        sa.Column("next_action_due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "qualification",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("converted_deal_id", sa.UUID(), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
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
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('new','collecting','ready_for_review','qualified','disqualified',"
            "'converted','archived')",
            name="ck_leads_status",
        ),
        sa.CheckConstraint(
            "source_channel IN ('voice','whatsapp','manual','api')", name="ck_leads_source_channel"
        ),
        sa.CheckConstraint("revision >= 1", name="ck_leads_revision_positive"),
        sa.CheckConstraint("length(btrim(reference)) > 0", name="ck_leads_reference_nonempty"),
        sa.CheckConstraint(
            "(field_schema_id IS NULL) = (field_schema_version IS NULL)",
            name="ck_leads_field_schema_pinned_together",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(qualification) = 'object'", name="ck_leads_qualification_object"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_profile_version_id"],
            ["agents.agent_profile_versions.tenant_id", "agents.agent_profile_versions.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "field_schema_id"],
            ["crm.lead_field_schemas.tenant_id", "crm.lead_field_schemas.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "source_conversation_id"],
            ["messaging.conversations.tenant_id", "messaging.conversations.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "handoff_id"],
            ["automation.handoffs.tenant_id", "automation.handoffs.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_leads_tenant_id_id"),
        schema="crm",
    )
    op.create_index(
        "uq_leads_tenant_reference",
        "leads",
        ["tenant_id", sa.text("lower(reference)")],
        unique=True,
        schema="crm",
    )
    # Concurrent creation guard. Two workers racing on the same interest collide
    # here instead of producing duplicate leads for one customer intent.
    op.create_index(
        "uq_leads_open_interest",
        "leads",
        ["tenant_id", "contact_id", "interest_key"],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL AND interest_key IS NOT NULL"),
        schema="crm",
    )
    op.create_index(
        "ix_leads_tenant_status_time",
        "leads",
        ["tenant_id", "status", sa.text("updated_at DESC"), sa.text("id DESC")],
        schema="crm",
    )
    op.create_index(
        "ix_leads_tenant_owner_time",
        "leads",
        ["tenant_id", "owner_user_id", sa.text("updated_at DESC"), sa.text("id DESC")],
        schema="crm",
    )
    op.create_index(
        "ix_leads_tenant_contact_time",
        "leads",
        ["tenant_id", "contact_id", sa.text("updated_at DESC"), sa.text("id DESC")],
        schema="crm",
    )
    op.create_index(
        "ix_leads_tenant_agent_version",
        "leads",
        ["tenant_id", "agent_profile_version_id", sa.text("updated_at DESC")],
        schema="crm",
    )

    op.create_table(
        "lead_field_values",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("lead_id", sa.UUID(), nullable=False),
        sa.Column("field_key", sa.Text(), nullable=False),
        sa.Column("value_state", sa.Text(), nullable=False),
        sa.Column("value_type", sa.Text(), nullable=False, server_default="text"),
        # The customer's own words survive next to the normalized form: a phone
        # re-spelled digit by digit is evidence, its E.164 form is the value.
        sa.Column("raw_value", sa.Text(), nullable=True),
        sa.Column("normalized_value", sa.Text(), nullable=True),
        sa.Column("value_currency", sa.String(length=3), nullable=True),
        sa.Column("source_channel", sa.Text(), nullable=False),
        sa.Column("source_reference_kind", sa.Text(), nullable=False),
        sa.Column("source_reference_id", sa.Text(), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confirmation_status", sa.Text(), nullable=False, server_default="unconfirmed"),
        sa.Column("recorded_by", sa.Text(), nullable=False),
        sa.Column("recorded_by_user_id", sa.UUID(), nullable=True),
        sa.Column("agent_profile_version_id", sa.UUID(), nullable=True),
        sa.Column("superseded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("superseded_by_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "field_key ~ '^[a-z][a-z0-9_]{0,62}$'", name="ck_lead_field_value_key_shape"
        ),
        sa.CheckConstraint(
            "value_state IN ('known','unknown','declined','not_applicable')",
            name="ck_lead_field_value_state",
        ),
        sa.CheckConstraint(
            "value_type IN ('text','number','currency','date','email','phone','boolean','choice')",
            name="ck_lead_field_value_type",
        ),
        sa.CheckConstraint(
            "source_channel IN ('voice','whatsapp','manual','import','api')",
            name="ck_lead_field_value_source_channel",
        ),
        sa.CheckConstraint(
            "source_reference_kind IN ('message','voice_turn','manual','import','api')",
            name="ck_lead_field_value_source_kind",
        ),
        sa.CheckConstraint(
            "confirmation_status IN ('unconfirmed','customer_confirmed','human_verified')",
            name="ck_lead_field_value_confirmation",
        ),
        sa.CheckConstraint(
            "recorded_by IN ('agent','human','system')", name="ck_lead_field_value_recorded_by"
        ),
        # Missing is not zero and refusal is not consent: only a known value may
        # carry content, and a known value may never be blank.
        sa.CheckConstraint(
            "(value_state = 'known') = (raw_value IS NOT NULL)",
            name="ck_lead_field_value_known_has_raw",
        ),
        sa.CheckConstraint(
            "raw_value IS NULL OR length(btrim(raw_value)) BETWEEN 1 AND 1200",
            name="ck_lead_field_value_raw_bounded",
        ),
        sa.CheckConstraint(
            "value_currency IS NULL OR value_currency ~ '^[A-Z]{3}$'",
            name="ck_lead_field_value_currency_iso",
        ),
        sa.CheckConstraint(
            "(superseded_at IS NULL) OR (superseded_by_id IS NOT NULL)",
            name="ck_lead_field_value_supersede_pair",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "lead_id"],
            ["crm.leads.tenant_id", "crm.leads.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_profile_version_id"],
            ["agents.agent_profile_versions.tenant_id", "agents.agent_profile_versions.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(["recorded_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_lead_field_values_tenant_id_id"),
        schema="crm",
    )
    op.create_index(
        "uq_lead_field_values_current",
        "lead_field_values",
        ["tenant_id", "lead_id", "field_key"],
        unique=True,
        postgresql_where=sa.text("superseded_at IS NULL"),
        schema="crm",
    )
    op.create_index(
        "ix_lead_field_values_history",
        "lead_field_values",
        ["tenant_id", "lead_id", sa.text("created_at DESC"), sa.text("id DESC")],
        schema="crm",
    )

    op.create_table(
        "lead_operations",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("lead_id", sa.UUID(), nullable=True),
        # Caller-supplied and derived from durable facts (interaction plus turn),
        # never from a freshly generated tool-call ID, so a retry after a restart
        # still recognises its own committed write.
        sa.Column("operation_key", sa.Text(), nullable=False),
        sa.Column("operation", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column(
            "receipt",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("error_safe", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending','committed','failed')", name="ck_lead_operation_status"
        ),
        sa.CheckConstraint(
            "operation IN ('lead.create','lead.save_fields','lead.finalize',"
            "'lead.request_follow_up','lead.update')",
            name="ck_lead_operation_name",
        ),
        sa.CheckConstraint(
            "length(btrim(operation_key)) BETWEEN 8 AND 200", name="ck_lead_operation_key_bounded"
        ),
        sa.CheckConstraint("jsonb_typeof(receipt) = 'object'", name="ck_lead_operation_receipt"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "lead_id"],
            ["crm.leads.tenant_id", "crm.leads.id"],
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("tenant_id", "operation_key", name="uq_lead_operations_tenant_key"),
        schema="crm",
    )
    op.create_index(
        "ix_lead_operations_lead",
        "lead_operations",
        ["tenant_id", "lead_id", sa.text("created_at DESC")],
        schema="crm",
    )

    for table in _TENANT_TABLES:
        _tenant_policy(table)

    op.execute(sa.text('GRANT USAGE ON SCHEMA crm TO "platform_worker"'))
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON crm.leads, crm.lead_field_values, "
        "crm.lead_operations, crm.lead_field_schemas TO platform_web"
    )
    # The conversational runtimes may capture and correct lead data. They may not
    # delete it, and they may not author the reviewed schema that bounds it.
    for role in ("platform_messaging", "platform_voice", "platform_worker"):
        op.execute(
            sa.text(
                "GRANT SELECT, INSERT, UPDATE ON crm.leads, crm.lead_field_values, "
                f"crm.lead_operations TO {role}"
            )
        )
        op.execute(sa.text(f"GRANT SELECT ON crm.lead_field_schemas TO {role}"))
    op.execute(
        "GRANT SELECT ON crm.leads, crm.lead_field_values, crm.lead_operations, "
        "crm.lead_field_schemas TO platform_readonly"
    )
    # An agent states which business it speaks for, on every channel, and that
    # identity is the tenant's rather than the prompt's. Voice already reads it
    # through this narrow tenant-bound projection; WhatsApp now reads the same
    # one instead of being granted crm.tenant_settings columns of its own, so
    # both channels compose identity from one source and the messaging role
    # still cannot select display_name directly.
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "platform.current_voice_tenant_support_profile() TO platform_messaging"
    )
    op.execute(
        "COMMENT ON FUNCTION platform.current_voice_tenant_support_profile() IS "
        "'Tenant identity for conversational runtimes on every channel: voice "
        "and WhatsApp both compose the agent''s self-identification from this "
        "projection.'"
    )


def downgrade() -> None:
    op.execute(
        "REVOKE EXECUTE ON FUNCTION "
        "platform.current_voice_tenant_support_profile() FROM platform_messaging"
    )
    op.execute("COMMENT ON FUNCTION platform.current_voice_tenant_support_profile() IS NULL")
    for table in ("lead_operations", "lead_field_values", "leads", "lead_field_schemas"):
        op.drop_table(table, schema="crm")
