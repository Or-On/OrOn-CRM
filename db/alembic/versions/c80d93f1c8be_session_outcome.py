"""session outcome

Which terminal node the flow ended on — the business result of a call.

Revision ID: c80d93f1c8be
Revises: f596c72044b0
Create Date: 2026-08-01
"""

import sqlalchemy as sa
from alembic import op

revision = "c80d93f1c8be"
down_revision = "f596c72044b0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Free text, not an enum: the endings are the tenant's own flow node names,
    # so a new outcome is an authoring change, never a migration.
    op.add_column("sessions", sa.Column("outcome", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("sessions", "outcome")
