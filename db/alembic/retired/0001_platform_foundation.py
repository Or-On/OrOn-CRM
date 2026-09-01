"""RETIRED: Phase 1 offline-only platform migration proof.

This file is intentionally outside ``versions/`` and is not part of the active
Alembic graph. It was never applied to a persistent database. Phase 2A preserved
the Or-on lineage as the canonical base and recreated this useful schema content
in a generated target-owned successor revision.

Revision ID: 0001_platform_foundation
Revises:
Create Date: 2026-08-31
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_platform_foundation"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS platform")
    op.create_table(
        "system_metadata",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.PrimaryKeyConstraint("key", name="pk_platform_system_metadata"),
        schema="platform",
    )


def downgrade() -> None:
    op.drop_table("system_metadata", schema="platform")
    op.execute("DROP SCHEMA IF EXISTS platform")
