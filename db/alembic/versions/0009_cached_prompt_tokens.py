"""Cached prompt tokens on sessions.

Revision ID: 0009
Revises: 0008
"""

import sqlalchemy as sa

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Zero, not NULL: rows written before this column existed billed every prompt
    # token at the full rate, which is exactly what zero cache hits re-prices to.
    op.add_column(
        "sessions",
        sa.Column(
            "llm_cached_prompt_tokens",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )


def downgrade() -> None:
    op.drop_column("sessions", "llm_cached_prompt_tokens")

