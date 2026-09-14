"""grant voice dispatcher callback conversation lookup

Revision ID: e1c47b9a2f60
Revises: d7a6e25f1c90
Create Date: 2026-09-14 17:10:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e1c47b9a2f60"
down_revision: str | None = "d7a6e25f1c90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A WhatsApp-triggered call is admitted by the voice dispatcher only after
    # it proves that the supplied conversation belongs to the same tenant and
    # contact. RLS remains the tenant boundary and the voice role receives no
    # message-body or mutation access.
    op.execute("GRANT USAGE ON SCHEMA messaging TO platform_voice")
    op.execute("GRANT SELECT ON messaging.conversations TO platform_voice")


def downgrade() -> None:
    op.execute("REVOKE SELECT ON messaging.conversations FROM platform_voice")
    op.execute("REVOKE USAGE ON SCHEMA messaging FROM platform_voice")
