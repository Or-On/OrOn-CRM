"""phone_numbers: dispatch_rule_id (SIP admission) replaces unused trunk_id

Revision ID: 0003
Revises: 0002
Create Date: 2026-07-21
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # trunk_id was provisioned-for but never used; the per-DID artifact is a
    # LiveKit dispatch rule. NOT NULL is safe — no phone_numbers rows exist yet
    # (0002 seeds only the default tenant).
    op.drop_column("phone_numbers", "trunk_id")
    op.add_column("phone_numbers", sa.Column("dispatch_rule_id", sa.String(), nullable=False))


def downgrade() -> None:
    op.drop_column("phone_numbers", "dispatch_rule_id")
    op.add_column("phone_numbers", sa.Column("trunk_id", sa.String(), nullable=True))
