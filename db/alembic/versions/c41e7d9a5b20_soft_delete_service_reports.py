"""retain deleted service reports as immutable audit evidence

Revision ID: c41e7d9a5b20
Revises: a84f9c2e6d31
Create Date: 2026-09-16 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c41e7d9a5b20"
down_revision: str | None = "a84f9c2e6d31"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "reports",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        schema="service",
    )
    op.add_column(
        "reports",
        sa.Column("deleted_by_user_id", sa.UUID(), nullable=True),
        schema="service",
    )
    op.create_foreign_key(
        "fk_service_reports_deleted_by_user",
        "reports",
        "users",
        ["deleted_by_user_id"],
        ["id"],
        source_schema="service",
        referent_schema="public",
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_service_reports_active_case",
        "reports",
        ["tenant_id", "case_id", "visit_id"],
        schema="service",
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_service_reports_active_case",
        table_name="reports",
        schema="service",
    )
    op.drop_constraint(
        "fk_service_reports_deleted_by_user",
        "reports",
        schema="service",
        type_="foreignkey",
    )
    op.drop_column("reports", "deleted_by_user_id", schema="service")
    op.drop_column("reports", "deleted_at", schema="service")
