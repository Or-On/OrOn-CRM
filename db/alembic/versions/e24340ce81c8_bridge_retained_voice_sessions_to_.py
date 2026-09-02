"""bridge retained voice sessions to canonical platform

Revision ID: e24340ce81c8
Revises: b56eb0a0aca1
Create Date: 2026-09-02 09:57:01.378638
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e24340ce81c8"
down_revision: str | None = "b56eb0a0aca1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Retained public tables keep their names and lifecycle semantics. Composite
    # keys are added only to make every new cross-domain relationship prove that
    # both rows belong to the same tenant.
    op.create_unique_constraint(
        "uq_sessions_tenant_id_session_id", "sessions", ["tenant_id", "session_id"]
    )
    op.create_unique_constraint("uq_voice_campaigns_tenant_id_id", "campaigns", ["tenant_id", "id"])

    for name in (
        "contact_id",
        "platform_campaign_id",
        "initiated_by_user_id",
        "recording_object_id",
        "transcript_object_id",
    ):
        op.add_column("sessions", sa.Column(name, sa.UUID(), nullable=True))
    op.add_column("sessions", sa.Column("initiated_by_service", sa.Text(), nullable=True))
    op.add_column("sessions", sa.Column("provider_call_id", sa.Text(), nullable=True))
    op.add_column("sessions", sa.Column("idempotency_key", sa.Text(), nullable=True))

    op.create_foreign_key(
        "fk_sessions_platform_campaign",
        "sessions",
        "campaigns",
        ["tenant_id", "platform_campaign_id"],
        ["tenant_id", "id"],
        referent_schema="platform",
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_sessions_initiated_by_user",
        "sessions",
        "users",
        ["initiated_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    # PostgreSQL 18 can null only the optional reference column while retaining
    # tenant_id. Generic ON DELETE SET NULL would also try to null tenant_id and
    # violate the table's tenant invariant.
    op.execute(
        "ALTER TABLE public.sessions ADD CONSTRAINT fk_sessions_contact "
        "FOREIGN KEY (tenant_id, contact_id) REFERENCES crm.contacts(tenant_id, id) "
        "ON DELETE SET NULL (contact_id)"
    )
    for column, constraint in (
        ("recording_object_id", "fk_sessions_recording_object"),
        ("transcript_object_id", "fk_sessions_transcript_object"),
    ):
        op.execute(
            f"ALTER TABLE public.sessions ADD CONSTRAINT {constraint} "
            f"FOREIGN KEY (tenant_id, {column}) "
            "REFERENCES objects.object_metadata(tenant_id, id) "
            f"ON DELETE SET NULL ({column})"
        )
    op.create_check_constraint(
        "ck_sessions_initiator",
        "sessions",
        "num_nonnulls(initiated_by_user_id, initiated_by_service) <= 1",
    )
    op.create_check_constraint(
        "ck_sessions_distinct_artifacts",
        "sessions",
        "recording_object_id IS NULL OR transcript_object_id IS NULL "
        "OR recording_object_id <> transcript_object_id",
    )
    op.create_index(
        "ix_sessions_tenant_cursor",
        "sessions",
        ["tenant_id", sa.text("created_at DESC"), sa.text("session_id DESC")],
    )
    op.create_index(
        "ix_sessions_contact_cursor",
        "sessions",
        ["tenant_id", "contact_id", sa.text("created_at DESC"), sa.text("session_id DESC")],
        postgresql_where=sa.text("contact_id IS NOT NULL"),
    )
    op.create_index(
        "uq_sessions_provider_call",
        "sessions",
        ["tenant_id", "provider", "provider_call_id"],
        unique=True,
        postgresql_where=sa.text("provider_call_id IS NOT NULL"),
    )
    op.create_index(
        "uq_sessions_idempotency",
        "sessions",
        ["tenant_id", "provider", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )

    op.add_column("campaigns", sa.Column("platform_campaign_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_voice_campaigns_platform_campaign",
        "campaigns",
        "campaigns",
        ["tenant_id", "platform_campaign_id"],
        ["tenant_id", "id"],
        referent_schema="platform",
        ondelete="RESTRICT",
    )
    op.create_index(
        "uq_voice_campaigns_platform_campaign",
        "campaigns",
        ["tenant_id", "platform_campaign_id"],
        unique=True,
        postgresql_where=sa.text("platform_campaign_id IS NOT NULL"),
    )

    op.add_column("campaign_contacts", sa.Column("contact_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_campaign_contacts_tenant_campaign",
        "campaign_contacts",
        "campaigns",
        ["tenant_id", "campaign_id"],
        ["tenant_id", "id"],
        ondelete="CASCADE",
    )
    op.execute(
        "ALTER TABLE public.campaign_contacts ADD CONSTRAINT fk_campaign_contacts_contact "
        "FOREIGN KEY (tenant_id, contact_id) REFERENCES crm.contacts(tenant_id, id) "
        "ON DELETE SET NULL (contact_id)"
    )
    op.execute(
        "ALTER TABLE public.campaign_contacts ADD CONSTRAINT fk_campaign_contacts_session "
        "FOREIGN KEY (tenant_id, session_id) REFERENCES public.sessions(tenant_id, session_id) "
        "ON DELETE SET NULL (session_id)"
    )
    op.create_index(
        "ix_campaign_contacts_contact",
        "campaign_contacts",
        ["tenant_id", "contact_id", "position"],
        postgresql_where=sa.text("contact_id IS NOT NULL"),
    )

    op.create_table(
        "session_events",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("provider", sa.Text(), nullable=True),
        sa.Column("provider_event_id", sa.Text(), nullable=True),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "session_id"],
            ["sessions.tenant_id", "sessions.session_id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint("sequence >= 0", name="ck_session_events_sequence"),
        sa.CheckConstraint("version > 0", name="ck_session_events_version"),
        sa.CheckConstraint("event_type <> ''", name="ck_session_events_type_nonempty"),
        sa.CheckConstraint(
            "jsonb_typeof(payload) = 'object'", name="ck_session_events_payload_object"
        ),
        sa.CheckConstraint(
            "provider_event_id IS NULL OR provider IS NOT NULL",
            name="ck_session_events_provider_scope",
        ),
        sa.UniqueConstraint(
            "tenant_id", "session_id", "sequence", name="uq_session_events_sequence"
        ),
    )
    op.create_index(
        "ix_session_events_cursor",
        "session_events",
        ["tenant_id", "session_id", "sequence", "id"],
    )
    op.create_index(
        "uq_session_events_provider_event",
        "session_events",
        ["tenant_id", "provider", "provider_event_id"],
        unique=True,
        postgresql_where=sa.text("provider_event_id IS NOT NULL"),
    )
    op.create_index(
        "uq_session_events_idempotency",
        "session_events",
        ["tenant_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )
    op.execute("ALTER TABLE public.session_events ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.session_events FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY session_events_tenant_isolation ON public.session_events "
        "USING (tenant_id = platform.current_tenant_id()) "
        "WITH CHECK (tenant_id = platform.current_tenant_id())"
    )

    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions, public.campaigns, "
        "public.campaign_contacts TO platform_voice"
    )
    op.execute("GRANT SELECT, INSERT ON public.session_events TO platform_voice")
    op.execute("GRANT SELECT ON public.sessions, public.session_events TO platform_readonly")
    op.execute("GRANT USAGE ON SCHEMA audit, ops TO platform_voice")
    op.execute("GRANT SELECT, INSERT ON audit.records, ops.outbox_events TO platform_voice")


def downgrade() -> None:
    op.execute("REVOKE SELECT, INSERT ON audit.records, ops.outbox_events FROM platform_voice")
    op.execute("REVOKE USAGE ON SCHEMA audit, ops FROM platform_voice")
    op.execute("REVOKE SELECT ON public.sessions, public.session_events FROM platform_readonly")
    op.execute("REVOKE SELECT, INSERT ON public.session_events FROM platform_voice")
    op.execute(
        "REVOKE SELECT, INSERT, UPDATE, DELETE ON public.sessions, public.campaigns, "
        "public.campaign_contacts FROM platform_voice"
    )
    op.drop_table("session_events")
    op.drop_index("ix_campaign_contacts_contact", table_name="campaign_contacts")
    op.drop_constraint("fk_campaign_contacts_session", "campaign_contacts", type_="foreignkey")
    op.drop_constraint("fk_campaign_contacts_contact", "campaign_contacts", type_="foreignkey")
    op.drop_constraint(
        "fk_campaign_contacts_tenant_campaign", "campaign_contacts", type_="foreignkey"
    )
    op.drop_column("campaign_contacts", "contact_id")
    op.drop_index("uq_voice_campaigns_platform_campaign", table_name="campaigns")
    op.drop_constraint("fk_voice_campaigns_platform_campaign", "campaigns", type_="foreignkey")
    op.drop_column("campaigns", "platform_campaign_id")

    op.drop_index("uq_sessions_idempotency", table_name="sessions")
    op.drop_index("uq_sessions_provider_call", table_name="sessions")
    op.drop_index("ix_sessions_contact_cursor", table_name="sessions")
    op.drop_index("ix_sessions_tenant_cursor", table_name="sessions")
    op.drop_constraint("ck_sessions_distinct_artifacts", "sessions", type_="check")
    op.drop_constraint("ck_sessions_initiator", "sessions", type_="check")
    op.drop_constraint("fk_sessions_transcript_object", "sessions", type_="foreignkey")
    op.drop_constraint("fk_sessions_recording_object", "sessions", type_="foreignkey")
    op.drop_constraint("fk_sessions_contact", "sessions", type_="foreignkey")
    op.drop_constraint("fk_sessions_initiated_by_user", "sessions", type_="foreignkey")
    op.drop_constraint("fk_sessions_platform_campaign", "sessions", type_="foreignkey")
    for name in (
        "idempotency_key",
        "provider_call_id",
        "initiated_by_service",
        "transcript_object_id",
        "recording_object_id",
        "initiated_by_user_id",
        "platform_campaign_id",
        "contact_id",
    ):
        op.drop_column("sessions", name)
    op.drop_constraint("uq_voice_campaigns_tenant_id_id", "campaigns", type_="unique")
    op.drop_constraint("uq_sessions_tenant_id_session_id", "sessions", type_="unique")
