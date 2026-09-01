"""Caller-perceived response latency on sessions.

Revision ID: 0010
Revises: 0009
"""

import sqlalchemy as sa

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

_COLUMNS = ("response_p50_ms", "response_p95_ms")


def upgrade() -> None:
    # Nullable, unlike the usage counters: zero would read as an instant reply.
    for name in _COLUMNS:
        op.add_column("sessions", sa.Column(name, sa.Float(), nullable=True))
    op.add_column(
        "sessions",
        sa.Column("response_turns", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )


def downgrade() -> None:
    op.drop_column("sessions", "response_turns")
    for name in reversed(_COLUMNS):
        op.drop_column("sessions", name)

