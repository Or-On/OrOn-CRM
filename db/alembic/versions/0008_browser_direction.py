"""`browser` direction, so a console test is not counted as a real call

Revision ID: 0008
Revises: 0007
Create Date: 2026-07-26
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Safe inside alembic's transaction on PG12+: only *using* a value added in
    # the same transaction is forbidden, and nothing here writes one. IF NOT
    # EXISTS because a re-run of a failed batch would otherwise abort.
    op.execute(sa.text("ALTER TYPE direction ADD VALUE IF NOT EXISTS 'browser'"))


def downgrade() -> None:
    # PostgreSQL cannot drop a value from an enum; removing it means rebuilding
    # the type and every column using it. Not worth it for a value whose only
    # cost is going unused.
    pass
