"""backfill existing tenant defaults

Revision ID: ac18e9d47b20
Revises: f8be561f06de
Create Date: 2026-09-11 14:28:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "ac18e9d47b20"
down_revision: str | None = "f8be561f06de"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Older development and early integrated environments may have created a
    # tenant before the CRM settings table existed.  Keep the administrator
    # directory and campaign wallet complete for every retained tenant.
    op.execute(
        """
        INSERT INTO crm.tenant_settings(
          tenant_id, display_name, default_currency, locale, timezone
        )
        SELECT tenant.id, tenant.name, 'USD', 'en', 'UTC'
        FROM public.tenants tenant
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )
    op.execute(
        """
        INSERT INTO billing.wallets(tenant_id, currency)
        SELECT settings.tenant_id, settings.default_currency
        FROM crm.tenant_settings settings
        ON CONFLICT (tenant_id) DO NOTHING
        """
    )


def downgrade() -> None:
    # Backfilled rows are now user-owned configuration and financial roots.
    # Removing them during downgrade would be destructive.
    pass
