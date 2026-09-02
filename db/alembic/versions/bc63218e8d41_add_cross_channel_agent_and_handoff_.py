"""Add cross-channel agent, execution, handoff, and activity foundations.

Revision ID: bc63218e8d41
Revises: 7beb64e1ff33
Create Date: 2026-09-02 17:19:23.183798
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "bc63218e8d41"
down_revision: str | None = "7beb64e1ff33"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _tenant_policy(table: str, schema: str) -> None:
    qualified = f'"{schema}"."{table}"'
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
        "agent_profiles",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
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
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("tenant_id", "id", name="uq_agent_profiles_tenant_id_id"),
        schema="agents",
    )
    op.create_index(
        "uq_agent_profiles_name",
        "agent_profiles",
        ["tenant_id", sa.text("lower(name)")],
        unique=True,
        schema="agents",
    )
    op.create_table(
        "agent_profile_versions",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("agent_profile_id", sa.UUID(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.Text(), nullable=False, server_default="1.0"),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("locale", sa.Text(), nullable=False, server_default="en"),
        sa.Column("model_configuration_id", sa.UUID(), nullable=True),
        sa.Column("channel_capabilities", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column(
            "tool_permissions",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "knowledge_configuration",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "channel_configuration",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "escalation_configuration",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("validation_status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("validation_errors", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_profile_id"],
            ["agents.agent_profiles.tenant_id", "agents.agent_profiles.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "model_configuration_id"],
            ["agents.model_configurations.tenant_id", "agents.model_configurations.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint("version > 0", name="ck_agent_profile_version_positive"),
        sa.CheckConstraint(
            "length(btrim(system_prompt)) > 0", name="ck_agent_profile_prompt_nonempty"
        ),
        sa.CheckConstraint(
            "cardinality(channel_capabilities) > 0", name="ck_agent_profile_channels_nonempty"
        ),
        sa.CheckConstraint(
            "channel_capabilities <@ ARRAY['voice','whatsapp']::text[]",
            name="ck_agent_profile_channels_supported",
        ),
        sa.CheckConstraint(
            "validation_status IN ('pending','valid','invalid')", name="ck_agent_profile_validation"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(tool_permissions) = 'array'", name="ck_agent_profile_tools_array"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(knowledge_configuration) = 'object'",
            name="ck_agent_profile_knowledge_object",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(channel_configuration) = 'object'",
            name="ck_agent_profile_channel_config_object",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(escalation_configuration) = 'object'",
            name="ck_agent_profile_escalation_object",
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_agent_profile_versions_tenant_id_id"),
        sa.UniqueConstraint("agent_profile_id", "version", name="uq_agent_profile_version"),
        schema="agents",
    )
    op.create_index(
        "ix_agent_profile_versions_published",
        "agent_profile_versions",
        ["tenant_id", "agent_profile_id", sa.text("version DESC")],
        schema="agents",
        postgresql_where=sa.text("published_at IS NOT NULL"),
    )
    op.execute("""
        CREATE FUNCTION agents.protect_published_agent_profile_version()
        RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        BEGIN
          IF OLD.published_at IS NOT NULL THEN
            RAISE EXCEPTION
              'published agent profile versions are immutable'
              USING ERRCODE = '55000';
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
        """)
    op.execute(
        "REVOKE ALL ON FUNCTION agents.protect_published_agent_profile_version() FROM PUBLIC"
    )
    op.execute("""
        CREATE TRIGGER trg_protect_published_agent_profile_version
        BEFORE UPDATE OR DELETE ON agents.agent_profile_versions
        FOR EACH ROW
        EXECUTE FUNCTION agents.protect_published_agent_profile_version()
        """)

    op.add_column(
        "flow_versions",
        sa.Column("agent_profile_version_id", sa.UUID(), nullable=True),
        schema="automation",
    )
    op.add_column(
        "flow_versions",
        sa.Column(
            "compiled_adapters",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        schema="automation",
    )
    op.create_foreign_key(
        "fk_flow_versions_agent_profile_version",
        "flow_versions",
        "agent_profile_versions",
        ["tenant_id", "agent_profile_version_id"],
        ["tenant_id", "id"],
        source_schema="automation",
        referent_schema="agents",
        ondelete="RESTRICT",
    )
    op.create_check_constraint(
        "ck_flow_versions_compiled_adapters_object",
        "flow_versions",
        "jsonb_typeof(compiled_adapters) = 'object'",
        schema="automation",
    )
    op.add_column(
        "flow_runs", sa.Column("idempotency_key", sa.Text(), nullable=True), schema="automation"
    )
    op.create_index(
        "uq_flow_runs_idempotency",
        "flow_runs",
        ["tenant_id", "idempotency_key"],
        unique=True,
        schema="automation",
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )

    op.create_table(
        "handoffs",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("contact_id", sa.UUID(), nullable=False),
        sa.Column("flow_run_id", sa.UUID(), nullable=True),
        sa.Column("conversation_id", sa.UUID(), nullable=True),
        sa.Column("session_id", sa.UUID(), nullable=True),
        sa.Column("requested_by_user_id", sa.UUID(), nullable=True),
        sa.Column("assigned_user_id", sa.UUID(), nullable=True),
        sa.Column("source_channel", sa.Text(), nullable=False),
        sa.Column("reason_safe", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column(
            "requested_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "contact_id"],
            ["crm.contacts.tenant_id", "crm.contacts.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "flow_run_id"],
            ["automation.flow_runs.tenant_id", "automation.flow_runs.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "conversation_id"],
            ["messaging.conversations.tenant_id", "messaging.conversations.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "session_id"],
            ["public.sessions.tenant_id", "public.sessions.session_id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(["requested_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["assigned_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.CheckConstraint(
            "source_channel IN ('voice','whatsapp')", name="ck_handoffs_source_channel"
        ),
        sa.CheckConstraint(
            "status IN ('pending','accepted','resolved','cancelled')", name="ck_handoffs_status"
        ),
        sa.CheckConstraint(
            "length(btrim(reason_safe)) BETWEEN 1 AND 500", name="ck_handoffs_reason_safe"
        ),
        sa.UniqueConstraint("tenant_id", "id", name="uq_handoffs_tenant_id_id"),
        sa.UniqueConstraint("tenant_id", "idempotency_key", name="uq_handoffs_idempotency"),
        schema="automation",
    )
    op.create_index(
        "ix_handoffs_queue",
        "handoffs",
        ["tenant_id", "status", "requested_at", "id"],
        schema="automation",
    )
    op.create_index(
        "ix_handoffs_contact_cursor",
        "handoffs",
        ["tenant_id", "contact_id", sa.text("requested_at DESC"), sa.text("id DESC")],
        schema="automation",
    )

    for table, schema in (
        ("agent_profiles", "agents"),
        ("agent_profile_versions", "agents"),
        ("handoffs", "automation"),
    ):
        _tenant_policy(table, schema)
    op.execute("""
        GRANT SELECT, INSERT, UPDATE, DELETE
        ON agents.agent_profiles, agents.agent_profile_versions
        TO platform_web
        """)
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON automation.handoffs TO platform_web")
    op.execute("GRANT SELECT, INSERT ON ops.jobs TO platform_web")
    op.execute("""
        GRANT SELECT
        ON agents.agent_profiles, agents.agent_profile_versions, automation.handoffs
        TO platform_readonly
        """)
    op.execute("GRANT USAGE ON SCHEMA agents TO platform_voice, platform_messaging")
    op.execute("""
        GRANT SELECT ON agents.agent_profiles, agents.agent_profile_versions
        TO platform_voice, platform_messaging
        """)
    op.execute("""
        GRANT SELECT (tenant_id, session_id, contact_id, status, outcome,
                      answered, created_at)
        ON public.sessions TO platform_web, platform_readonly
        """)

    op.execute("""
        CREATE VIEW platform.contact_activity WITH (security_invoker = true) AS
        SELECT m.tenant_id, m.id AS event_id, c.contact_id, 'message'::text AS source_type,
               ('message.' || m.direction::text || '.' || m.status::text) AS event_type,
               m.created_at AS occurred_at,
               jsonb_build_object(
                 'conversation_id', m.conversation_id,
                 'content_type', m.content_type,
                 'direction', m.direction,
                 'status', m.status
               ) AS metadata
        FROM messaging.messages m JOIN messaging.conversations c
          ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
        UNION ALL
        SELECT s.tenant_id, s.session_id, s.contact_id, 'voice',
               ('voice.call.' || s.status::text), s.created_at,
               jsonb_build_object(
                 'status', s.status,
                 'outcome', s.outcome,
                 'answered', s.answered
               )
        FROM public.sessions s WHERE s.contact_id IS NOT NULL
        UNION ALL
        SELECT d.tenant_id, d.id, d.contact_id, 'deal',
               ('crm.deal.' || d.status::text), d.updated_at,
               jsonb_build_object(
                 'status', d.status,
                 'stage_id', d.stage_id,
                 'currency', d.currency
               )
        FROM crm.deals d WHERE d.contact_id IS NOT NULL
        UNION ALL
        SELECT r.tenant_id, r.id, r.contact_id, 'automation',
               ('automation.run.' || r.status::text), r.created_at,
               jsonb_build_object(
                 'status', r.status,
                 'trigger_type', r.trigger_type,
                 'flow_version_id', r.flow_version_id
               )
        FROM automation.flow_runs r WHERE r.contact_id IS NOT NULL
        UNION ALL
        SELECT recipient.tenant_id, recipient.id, recipient.contact_id, 'campaign',
               ('campaign.messaging.' || recipient.status::text),
               COALESCE(recipient.replied_at, recipient.read_at,
                        recipient.delivered_at, recipient.sent_at,
                        recipient.created_at),
               jsonb_build_object(
                 'broadcast_id', recipient.broadcast_id,
                 'status', recipient.status,
                 'attempts', recipient.attempts
               )
        FROM messaging.broadcast_recipients recipient
        UNION ALL
        SELECT h.tenant_id, h.id, h.contact_id, 'handoff',
               ('handoff.' || h.status::text), h.requested_at,
               jsonb_build_object(
                 'status', h.status,
                 'source_channel', h.source_channel,
                 'assigned_user_id', h.assigned_user_id
               )
        FROM automation.handoffs h
        """)
    op.execute("GRANT SELECT ON platform.contact_activity TO platform_web, platform_readonly")


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS platform.contact_activity")
    op.execute("REVOKE SELECT, INSERT ON ops.jobs FROM platform_web")
    op.execute("""
        REVOKE SELECT (tenant_id, session_id, contact_id, status, outcome,
                       answered, created_at)
        ON public.sessions FROM platform_web, platform_readonly
        """)
    op.drop_table("handoffs", schema="automation")
    op.drop_index("uq_flow_runs_idempotency", table_name="flow_runs", schema="automation")
    op.drop_column("flow_runs", "idempotency_key", schema="automation")
    op.drop_constraint(
        "ck_flow_versions_compiled_adapters_object",
        "flow_versions",
        schema="automation",
        type_="check",
    )
    op.drop_constraint(
        "fk_flow_versions_agent_profile_version",
        "flow_versions",
        schema="automation",
        type_="foreignkey",
    )
    op.drop_column("flow_versions", "compiled_adapters", schema="automation")
    op.drop_column("flow_versions", "agent_profile_version_id", schema="automation")
    op.execute("""
        DROP TRIGGER IF EXISTS trg_protect_published_agent_profile_version
        ON agents.agent_profile_versions
        """)
    op.execute("DROP FUNCTION IF EXISTS agents.protect_published_agent_profile_version()")
    op.drop_table("agent_profile_versions", schema="agents")
    op.drop_table("agent_profiles", schema="agents")
