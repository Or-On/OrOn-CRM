"""fix tenant creation identifier

Revision ID: 39862f055865
Revises: c92f8341a7de
Create Date: 2026-09-12 18:24:15.576081
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "39862f055865"
down_revision: str | None = "c92f8341a7de"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "tenants",
        "id",
        existing_type=sa.UUID(),
        server_default=sa.text("gen_random_uuid()"),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "tenants",
        "id",
        existing_type=sa.UUID(),
        server_default=None,
        existing_nullable=False,
    )
