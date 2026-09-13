"""preserve tenant on conversation handoff delete

Revision ID: 585ee9ec1ca8
Revises: eb626a89c3a8
Create Date: 2026-09-12 23:50:43.986773
"""

from collections.abc import Sequence

from alembic import op

revision: str = "585ee9ec1ca8"
down_revision: str | None = "eb626a89c3a8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The original composite SET NULL action attempted to clear tenant_id as
    # well as conversation_id. tenant_id is deliberately NOT NULL because a
    # retained handoff must remain tenant-owned after its conversation is
    # deleted. PostgreSQL supports an explicit SET NULL column list.
    op.execute("""
        ALTER TABLE automation.handoffs
          DROP CONSTRAINT handoffs_tenant_id_conversation_id_fkey,
          ADD CONSTRAINT handoffs_tenant_id_conversation_id_fkey
            FOREIGN KEY (tenant_id,conversation_id)
            REFERENCES messaging.conversations(tenant_id,id)
            ON DELETE SET NULL (conversation_id)
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE automation.handoffs
          DROP CONSTRAINT handoffs_tenant_id_conversation_id_fkey,
          ADD CONSTRAINT handoffs_tenant_id_conversation_id_fkey
            FOREIGN KEY (tenant_id,conversation_id)
            REFERENCES messaging.conversations(tenant_id,id)
            ON DELETE SET NULL
    """)
