"""Establish the unified platform foundation and successor runtime roles.

Revision ID: 34376836baf5
Revises: a41d2f6c2925
Create Date: 2026-09-01 09:07:27.599222
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "34376836baf5"
down_revision: str | None = "a41d2f6c2925"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for schema in (
        "platform",
        "crm",
        "messaging",
        "automation",
        "agents",
        "live",
        "objects",
        "ops",
        "audit",
    ):
        op.execute(sa.text(f'CREATE SCHEMA IF NOT EXISTS "{schema}"'))
        op.execute(sa.text(f'REVOKE ALL ON SCHEMA "{schema}" FROM PUBLIC'))

    op.execute(
        sa.text(
            """
            DO $$
            DECLARE role_name text;
            BEGIN
              FOREACH role_name IN ARRAY ARRAY[
                'platform_migrator', 'platform_web', 'platform_messaging',
                'platform_voice', 'platform_worker', 'platform_readonly'
              ]
              LOOP
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
                  EXECUTE format(
                    'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE '
                    'NOINHERIT NOREPLICATION NOBYPASSRLS', role_name
                  );
                END IF;
              END LOOP;
            END
            $$
            """
        )
    )

    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION platform.current_tenant_id()
            RETURNS uuid
            LANGUAGE sql
            STABLE
            PARALLEL SAFE
            SET search_path = pg_catalog
            AS $$
              SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION platform.current_user_id()
            RETURNS uuid
            LANGUAGE sql
            STABLE
            PARALLEL SAFE
            SET search_path = pg_catalog
            AS $$
              SELECT NULLIF(current_setting('app.current_user', true), '')::uuid
            $$
            """
        )
    )
    op.execute("REVOKE ALL ON FUNCTION platform.current_tenant_id() FROM PUBLIC")
    op.execute("REVOKE ALL ON FUNCTION platform.current_user_id() FROM PUBLIC")

    op.create_table(
        "system_metadata",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        schema="platform",
    )
    op.create_table(
        "identity_bindings",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_subject", sa.Text(), nullable=False),
        sa.Column("provider_email", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.UniqueConstraint("provider", "provider_subject", name="uq_identity_provider_subject"),
        schema="platform",
    )
    op.create_index(
        "ix_identity_bindings_user", "identity_bindings", ["user_id"], schema="platform"
    )

    op.create_table(
        "tenant_invitations",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "invited_by_user_id",
            sa.UUID(),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "role IN ('owner', 'admin', 'agent', 'viewer')", name="ck_invitation_role"
        ),
        sa.ForeignKeyConstraint(["accepted_by_user_id"], ["users.id"], ondelete="SET NULL"),
        schema="platform",
    )
    op.create_index(
        "ix_tenant_invitations_open",
        "tenant_invitations",
        ["tenant_id", "expires_at"],
        unique=False,
        schema="platform",
        postgresql_where=sa.text("accepted_at IS NULL"),
    )

    op.create_table(
        "credential_records",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("display_hint", sa.Text(), nullable=True),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=True),
        sa.Column("nonce", sa.LargeBinary(), nullable=True),
        sa.Column("algorithm", sa.Text(), nullable=True),
        sa.Column("key_version", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("rotated_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(ciphertext IS NULL AND nonce IS NULL AND algorithm IS NULL AND key_version IS NULL) "
            "OR (ciphertext IS NOT NULL AND nonce IS NOT NULL AND algorithm IS NOT NULL "
            "AND key_version IS NOT NULL)",
            name="ck_credential_envelope_complete",
        ),
        schema="platform",
    )
    op.create_index(
        "ix_credential_records_tenant_kind",
        "credential_records",
        ["tenant_id", "kind"],
        schema="platform",
    )

    op.create_table(
        "campaigns",
        sa.Column("id", sa.UUID(), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column(
            "tenant_id",
            sa.UUID(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="draft"),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.CheckConstraint(
            "status IN ('draft', 'scheduled', 'running', 'paused', "
            "'completed', 'failed', 'cancelled')",
            name="ck_platform_campaign_status",
        ),
        sa.CheckConstraint(
            "channel IN ('voice', 'whatsapp', 'multi')", name="ck_platform_campaign_channel"
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        schema="platform",
    )
    op.create_index(
        "ix_platform_campaigns_tenant_status_schedule",
        "campaigns",
        ["tenant_id", "status", "scheduled_at", "id"],
        schema="platform",
    )

    tenant_tables = (
        ("platform", "tenant_invitations"),
        ("platform", "credential_records"),
        ("platform", "campaigns"),
    )
    for schema, table in tenant_tables:
        qualified = f'"{schema}"."{table}"'
        policy = f"{table}_tenant_isolation"
        op.execute(sa.text(f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY"))
        op.execute(sa.text(f"ALTER TABLE {qualified} FORCE ROW LEVEL SECURITY"))
        op.execute(
            sa.text(
                f"CREATE POLICY {policy} ON {qualified} "
                "USING (tenant_id = platform.current_tenant_id()) "
                "WITH CHECK (tenant_id = platform.current_tenant_id())"
            )
        )

    for role in (
        "platform_web",
        "platform_messaging",
        "platform_voice",
        "platform_worker",
        "platform_readonly",
    ):
        op.execute(sa.text(f'GRANT USAGE ON SCHEMA platform TO "{role}"'))
        op.execute(sa.text(f'GRANT EXECUTE ON FUNCTION platform.current_tenant_id() TO "{role}"'))
        op.execute(sa.text(f'GRANT EXECUTE ON FUNCTION platform.current_user_id() TO "{role}"'))

    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON platform.tenant_invitations TO platform_web"
    )
    op.execute("GRANT SELECT ON platform.campaigns TO platform_readonly")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON platform.campaigns TO platform_web")
    op.execute("GRANT SELECT ON platform.credential_records TO platform_web")


def downgrade() -> None:
    for table in ("campaigns", "credential_records", "tenant_invitations"):
        op.drop_table(table, schema="platform")
    op.drop_index("ix_identity_bindings_user", table_name="identity_bindings", schema="platform")
    op.drop_table("identity_bindings", schema="platform")
    op.drop_table("system_metadata", schema="platform")
    op.execute("DROP FUNCTION IF EXISTS platform.current_user_id()")
    op.execute("DROP FUNCTION IF EXISTS platform.current_tenant_id()")

    # Cluster-scoped roles may predate this migration (the Phase 1 local
    # bootstrap creates them). Downgrade therefore removes schema objects and
    # grants but deliberately leaves role lifecycle to the operator.
    for schema in ("audit", "ops", "objects", "live", "agents", "automation", "messaging", "crm"):
        op.execute(sa.text(f'DROP SCHEMA IF EXISTS "{schema}"'))
    op.execute("DROP SCHEMA IF EXISTS platform")
