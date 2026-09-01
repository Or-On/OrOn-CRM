"""multitenancy: control-plane tables, RLS, app role, seed, sessions.tenant_id

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-19
"""

import sqlalchemy as sa
from alembic import context, op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001"


def _app_role() -> str:
    """The non-superuser role the grants target. Defaults to `oron_app` (prod /
    standalone `alembic upgrade head`); the test harness injects a per-worker
    name (`oron_app_<worker>`) via `config.attributes['app_role']` so xdist runs,
    where the role is per-worker, grant the role that actually exists."""
    return context.config.attributes.get("app_role", "oron_app")


def _timestamps():
    return (
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )


def upgrade() -> None:
    op.create_table(
        "tenants",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        *_timestamps(),
    )
    op.create_index("ix_tenants_slug", "tenants", ["slug"])

    op.create_table(
        "phone_numbers",
        sa.Column("id", sa.Uuid(), primary_key=True),
        # Uniqueness is a unique index (matching the SQLModel Field(index=True,
        # unique=True)), not a separate column constraint — keeps `alembic check`
        # clean against the model.
        sa.Column("e164", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("trunk_id", sa.String(), nullable=True),
        *_timestamps(),
    )
    op.create_index("ix_phone_numbers_tenant_id", "phone_numbers", ["tenant_id"])
    op.create_index("ix_phone_numbers_e164", "phone_numbers", ["e164"], unique=True)

    op.create_table(
        "api_keys",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("hashed_key", sa.String(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), sa.ForeignKey("tenants.id"), nullable=True),
        sa.Column("kind", sa.String(), nullable=False, server_default="tenant"),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        *_timestamps(),
    )
    op.create_index("ix_api_keys_hashed_key", "api_keys", ["hashed_key"], unique=True)
    op.create_index("ix_api_keys_tenant_id", "api_keys", ["tenant_id"])

    # Seed the default tenant; existing sessions backfill to it.
    op.execute(
        sa.text(
            "INSERT INTO tenants (id, name, slug, status) "
            "VALUES (CAST(:id AS uuid), 'Default', 'default', 'active')"
        ).bindparams(id=DEFAULT_TENANT_ID)
    )

    # sessions: started_at -> created_at, add updated_at, add tenant_id
    op.alter_column("sessions", "started_at", new_column_name="created_at")
    op.add_column(
        "sessions",
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.add_column("sessions", sa.Column("tenant_id", sa.Uuid(), nullable=True))
    op.execute(
        sa.text("UPDATE sessions SET tenant_id = CAST(:t AS uuid)").bindparams(t=DEFAULT_TENANT_ID)
    )
    op.alter_column("sessions", "tenant_id", nullable=False)
    op.create_foreign_key("fk_sessions_tenant", "sessions", "tenants", ["tenant_id"], ["id"])
    op.create_index("ix_sessions_tenant_id", "sessions", ["tenant_id"])

    # Non-superuser app role (idempotent) + grants. The role's password is set
    # out-of-band (GCP Secret Manager), never in a migration. The grantee is
    # `oron_app` by default, or a per-worker role the test harness injects.
    role = _app_role()
    op.execute(
        f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='{role}') "
        f'THEN CREATE ROLE "{role}" LOGIN; END IF; END $$;'
    )
    op.execute(f'GRANT USAGE ON SCHEMA public TO "{role}"')
    op.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "{role}"')
    op.execute(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
        f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "{role}"'
    )

    # RLS on sessions (control-plane tables stay unrestricted).
    op.execute("ALTER TABLE sessions ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE sessions FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_iso ON sessions "
        "USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid) "
        "WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS tenant_iso ON sessions")
    op.execute("ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE sessions DISABLE ROW LEVEL SECURITY")
    op.drop_index("ix_sessions_tenant_id", "sessions")
    op.drop_constraint("fk_sessions_tenant", "sessions", type_="foreignkey")
    op.drop_column("sessions", "tenant_id")
    op.drop_column("sessions", "updated_at")
    op.alter_column("sessions", "created_at", new_column_name="started_at")
    op.drop_table("api_keys")
    op.drop_table("phone_numbers")
    op.drop_index("ix_tenants_slug", "tenants")
    op.drop_table("tenants")
