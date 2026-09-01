"""Drop session response latency.

Superseded by tracing: pipecat's own turn spans carry the same timing attached to
the text that produced it, so the row's percentiles were a lossier second copy.

Revision ID: 8eda5976c920
Revises: 0011
"""

import sqlalchemy as sa
from alembic import op

revision = "8eda5976c920"
down_revision = "0011"
branch_labels = None
depends_on = None

_NULLABLE = ("response_p50_ms", "response_p95_ms")


def upgrade() -> None:
    op.drop_column("sessions", "response_turns")
    for name in _NULLABLE:
        op.drop_column("sessions", name)


def downgrade() -> None:
    for name in _NULLABLE:
        op.add_column("sessions", sa.Column(name, sa.Float(), nullable=True))
    op.add_column(
        "sessions",
        sa.Column("response_turns", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )
