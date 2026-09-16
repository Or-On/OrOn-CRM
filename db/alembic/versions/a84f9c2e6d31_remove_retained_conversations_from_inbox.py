"""remove retained conversations from the inbox without erasing evidence

Revision ID: a84f9c2e6d31
Revises: 7d91e4a3c620
Create Date: 2026-09-16 02:25:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a84f9c2e6d31"
down_revision: str | None = "7d91e4a3c620"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("removed_from_inbox_at", sa.DateTime(timezone=True), nullable=True),
        schema="messaging",
    )
    op.add_column(
        "conversations",
        sa.Column("removed_from_inbox_by_user_id", sa.UUID(), nullable=True),
        schema="messaging",
    )
    op.create_foreign_key(
        "fk_conversations_removed_from_inbox_by_user",
        "conversations",
        "users",
        ["removed_from_inbox_by_user_id"],
        ["id"],
        source_schema="messaging",
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_conversations_visible_inbox",
        "conversations",
        ["tenant_id", "status", sa.text("last_message_at DESC"), sa.text("id DESC")],
        schema="messaging",
        postgresql_where=sa.text("removed_from_inbox_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_conversations_visible_inbox",
        table_name="conversations",
        schema="messaging",
    )
    op.drop_constraint(
        "fk_conversations_removed_from_inbox_by_user",
        "conversations",
        schema="messaging",
        type_="foreignkey",
    )
    op.drop_column("conversations", "removed_from_inbox_by_user_id", schema="messaging")
    op.drop_column("conversations", "removed_from_inbox_at", schema="messaging")
