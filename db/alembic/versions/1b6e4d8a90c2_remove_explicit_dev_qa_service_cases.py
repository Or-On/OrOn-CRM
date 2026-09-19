"""remove existing service cases before the QA reset

Revision ID: 1b6e4d8a90c2
Revises: 0f7b3c9d2a61
Create Date: 2026-09-19 23:05:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "1b6e4d8a90c2"
down_revision: str | None = "0f7b3c9d2a61"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The product owner requested a clean QA case queue. Existing foreign keys
    # cascade linked field-service evidence and set optional support-ticket
    # links to NULL without deleting contacts or support tickets.
    op.execute("DELETE FROM service.cases")


def downgrade() -> None:
    # Purged records and their evidence must not be recreated with
    # fabricated identifiers or content during a downgrade.
    pass
