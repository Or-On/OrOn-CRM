"""link support tasks to tenant contacts

Revision ID: 91bd6f76a3e4
Revises: e1c47b9a2f60
Create Date: 2026-09-14 17:12:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "91bd6f76a3e4"
down_revision: str | None = "e1c47b9a2f60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("contact_id", sa.UUID(), nullable=True), schema="crm")
    op.create_foreign_key(
        "fk_tasks_contact_tenant",
        "tasks",
        "contacts",
        ["tenant_id", "contact_id"],
        ["tenant_id", "id"],
        source_schema="crm",
        referent_schema="crm",
        ondelete="SET NULL (contact_id)",
    )
    op.create_index(
        "ix_tasks_tenant_contact_updated",
        "tasks",
        ["tenant_id", "contact_id", sa.text("updated_at DESC"), sa.text("id DESC")],
        schema="crm",
        postgresql_where=sa.text("contact_id IS NOT NULL"),
    )

    # Existing AI handoff receipts already bind each generated task to a
    # tenant-scoped handoff. Recover that relationship without parsing task
    # descriptions or trusting model-authored text.
    op.execute(
        """
        UPDATE crm.tasks AS task
        SET contact_id = handoff.contact_id
        FROM audit.records AS receipt
        JOIN automation.handoffs AS handoff
          ON handoff.tenant_id = receipt.tenant_id
         AND handoff.id = receipt.target_id
        WHERE receipt.action = 'conversation.ai_handoff_ticket'
          AND receipt.target_type = 'handoff'
          AND receipt.metadata->>'taskId' = task.id::text
          AND task.tenant_id = receipt.tenant_id
          AND task.contact_id IS NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_tasks_tenant_contact_updated", table_name="tasks", schema="crm")
    op.drop_constraint("fk_tasks_contact_tenant", "tasks", schema="crm", type_="foreignkey")
    op.drop_column("tasks", "contact_id", schema="crm")
