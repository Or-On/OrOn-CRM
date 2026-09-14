"""grant messaging worker tenant audit read access

Revision ID: d7a6e25f1c90
Revises: 3cbd28bebf1a
Create Date: 2026-09-14 16:35:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "d7a6e25f1c90"
down_revision: str | None = "3cbd28bebf1a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # AI handoff admission checks its own tenant-scoped audit receipt before it
    # creates a CRM ticket. Existing RLS remains the tenant boundary, while the
    # worker stays unable to update or delete immutable audit records.
    op.execute("GRANT SELECT ON audit.records TO platform_messaging")


def downgrade() -> None:
    op.execute("REVOKE SELECT ON audit.records FROM platform_messaging")
