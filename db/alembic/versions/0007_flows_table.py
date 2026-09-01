"""flows: published flow definitions, tenant-scoped with a shared packaged catalog

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-26
"""

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def _app_role() -> str:
    """See 0002 — `oron_app` in prod, a per-worker role under xdist."""
    return context.config.attributes.get("app_role", "oron_app")


def upgrade() -> None:
    op.create_table(
        "flows",
        # (flow_id, version): a flow keeps its id across versions, and a
        # published version is immutable — republishing inserts the next one.
        sa.Column("flow_id", sa.Uuid(), primary_key=True),
        sa.Column("version", sa.Integer(), primary_key=True),
        # NULL = the packaged catalog: owned by no tenant, runnable by all.
        sa.Column("tenant_id", sa.Uuid(), sa.ForeignKey("tenants.id"), nullable=True),
        sa.Column("source", postgresql.JSONB(), nullable=False),
        sa.Column("spec", postgresql.JSONB(), nullable=False),
        sa.Column("components_version", sa.String(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_flows_tenant_id", "flows", ["tenant_id"])

    # The app role is created in 0002, but ALTER DEFAULT PRIVILEGES only covers
    # tables created by the role that ran that statement. Grant explicitly.
    role = _app_role()
    op.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON flows TO "{role}"')

    # READ: a tenant sees the packaged catalog plus its own flows. An unscoped
    # (control-plane) connection sees only the packaged catalog, since
    # `tenant_id = NULL` is never true.
    #
    # WRITE: `IS NOT DISTINCT FROM` makes the rule "you may only write rows you
    # own" hold for both cases at once — a tenant-scoped connection writes its
    # own tenant_id, an unscoped one writes the packaged (NULL) catalog. A
    # tenant therefore cannot publish into the shared catalog, which a plain
    # `tenant_id = GUC` would have blocked for the boot-time convergence too.
    op.execute("ALTER TABLE flows ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE flows FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_iso ON flows "
        "USING (tenant_id IS NULL "
        "       OR tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid) "
        "WITH CHECK (tenant_id IS NOT DISTINCT FROM "
        "            NULLIF(current_setting('app.current_tenant', true), '')::uuid)"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS tenant_iso ON flows")
    op.execute("ALTER TABLE flows NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE flows DISABLE ROW LEVEL SECURITY")
    op.drop_index("ix_flows_tenant_id", "flows")
    op.drop_table("flows")
