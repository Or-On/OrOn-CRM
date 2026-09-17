"""re-assert the retained voice tables' RLS under their qualified names

Revision ID: c5f7a90b41de
Revises: b8e3f1a6c2d9
Create Date: 2026-09-17 19:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "c5f7a90b41de"
down_revision: str | None = "b8e3f1a6c2d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Verbatim from 0007, which is the behaviour this migration must not change.
# READ: a tenant sees the packaged catalog plus its own flows; an unscoped
# (control-plane) connection sees only the packaged catalog, since
# `tenant_id = NULL` is never true.
# WRITE: `IS NOT DISTINCT FROM` means "only rows you own" for both cases at
# once, so a tenant cannot publish into the shared packaged catalog.
_POLICY = (
    "USING (tenant_id IS NULL "
    "       OR tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid) "
    "WITH CHECK (tenant_id IS NOT DISTINCT FROM "
    "            NULLIF(current_setting('app.current_tenant', true), '')::uuid)"
)


# Verbatim from 46a2cce29f18. These rows carry no shared packaged catalog, so
# the policy is a plain tenant match in both directions.
_CAMPAIGN_POLICY = (
    "USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid) "
    "WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)"
)
_CAMPAIGN_TABLES = ("campaigns", "campaign_contacts")


def upgrade() -> None:
    # `0007` and `46a2cce29f18` enabled row level security on these tables
    # unqualified (`ALTER TABLE flows ...`). The database is therefore correct,
    # but the rendered-SQL contract check matches schema-qualified DDL only, so
    # the retained voice tables — including the flow catalog that decides what a
    # caller hears — were the tenant tables whose isolation nothing verified.
    # Re-asserting them under `public.` is a no-op against a correct database
    # and makes the invariant machine-checked from here on.
    op.execute("ALTER TABLE public.flows ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.flows FORCE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS tenant_iso ON public.flows")
    op.execute(f"CREATE POLICY tenant_iso ON public.flows {_POLICY}")
    for table in _CAMPAIGN_TABLES:
        op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE public.{table} FORCE ROW LEVEL SECURITY")
        op.execute(f"DROP POLICY IF EXISTS tenant_iso ON public.{table}")
        op.execute(f"CREATE POLICY tenant_iso ON public.{table} {_CAMPAIGN_POLICY}")


def downgrade() -> None:
    # Leave row level security enabled: dropping it is never the safe direction.
    op.execute("DROP POLICY IF EXISTS tenant_iso ON public.flows")
    op.execute(f"CREATE POLICY tenant_iso ON flows {_POLICY}")
    for table in _CAMPAIGN_TABLES:
        op.execute(f"DROP POLICY IF EXISTS tenant_iso ON public.{table}")
        op.execute(f"CREATE POLICY tenant_iso ON {table} {_CAMPAIGN_POLICY}")
