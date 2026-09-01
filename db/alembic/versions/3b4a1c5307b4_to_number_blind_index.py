"""to_number blind index

"Find every call to this number" needs an index on the callee too. Existing rows
keep NULL: the index is derived from a number this migration cannot read, so
backfilling would mean decrypting the table — the search will not find calls
placed before this ran.

Revision ID: 3b4a1c5307b4
Revises: c80d93f1c8be
Create Date: 2026-08-01
"""

import sqlalchemy as sa

from alembic import op

revision = "3b4a1c5307b4"
down_revision = "c80d93f1c8be"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sessions", sa.Column("to_number_bidx", sa.String(), nullable=True))
    op.create_index("ix_sessions_to_number_bidx", "sessions", ["to_number_bidx"])


def downgrade() -> None:
    op.drop_index("ix_sessions_to_number_bidx", table_name="sessions")
    op.drop_column("sessions", "to_number_bidx")

