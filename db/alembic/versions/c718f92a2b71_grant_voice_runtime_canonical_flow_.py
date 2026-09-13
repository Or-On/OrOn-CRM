"""grant voice runtime canonical flow access

Revision ID: c718f92a2b71
Revises: e139bf3fde7e
Create Date: 2026-09-09 23:48:59.416224
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c718f92a2b71"
down_revision: str | None = "e139bf3fde7e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The in-process dispatcher resolves the immutable agent profile attached
    # to a published canonical voice flow. It needs no write access here.
    op.execute(sa.text("GRANT USAGE ON SCHEMA automation TO platform_voice"))
    op.execute(sa.text("GRANT SELECT ON automation.flow_versions TO platform_voice"))


def downgrade() -> None:
    op.execute(sa.text("REVOKE SELECT ON automation.flow_versions FROM platform_voice"))
    op.execute(sa.text("REVOKE USAGE ON SCHEMA automation FROM platform_voice"))
