"""answered, no_answer and retry scheduling

Whether the callee picked up, and what a campaign does about it.

Revision ID: 7433e45e0d29
Revises: 46a2cce29f18
Create Date: 2026-08-01
"""

import sqlalchemy as sa

from alembic import op

revision = "7433e45e0d29"
down_revision = "46a2cce29f18"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable with no default: NULL is "not applicable" on an inbound row and
    # "not observed" on the outbound calls that predate this column. Defaulting
    # to false would retroactively assert nobody ever answered.
    op.add_column("sessions", sa.Column("answered", sa.Boolean(), nullable=True))

    op.add_column(
        "campaigns",
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "campaigns",
        sa.Column("retry_after_minutes", sa.Integer(), nullable=False, server_default="60"),
    )
    op.create_check_constraint(
        "ck_campaigns_max_attempts", "campaigns", "max_attempts >= 1 AND max_attempts <= 5"
    )
    op.create_check_constraint(
        "ck_campaigns_retry_after_minutes", "campaigns", "retry_after_minutes >= 1"
    )

    op.add_column(
        "campaign_contacts",
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("ALTER TYPE contactstatus ADD VALUE IF NOT EXISTS 'no_answer'")


def downgrade() -> None:
    op.drop_column("campaign_contacts", "next_attempt_at")
    op.drop_constraint("ck_campaigns_retry_after_minutes", "campaigns", type_="check")
    op.drop_constraint("ck_campaigns_max_attempts", "campaigns", type_="check")
    op.drop_column("campaigns", "retry_after_minutes")
    op.drop_column("campaigns", "max_attempts")
    op.drop_column("sessions", "answered")
    # The enum value stays. Removing one means recreating the type, and any row
    # still holding `no_answer` would block it — harmless to leave.

