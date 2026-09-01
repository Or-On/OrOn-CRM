"""calling window and a claim index that skips resting rows

Revision ID: f596c72044b0
Revises: 7433e45e0d29
Create Date: 2026-08-01
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "f596c72044b0"
down_revision = "7433e45e0d29"
branch_labels = None
depends_on = None

OLD_CLAIM = ("campaign_id", "status", "position")
NEW_CLAIM = ("campaign_id", "status", "next_attempt_at", "position")


def upgrade() -> None:
    op.add_column(
        "campaigns",
        sa.Column("timezone", sa.String(), nullable=False, server_default="Asia/Jerusalem"),
    )
    op.add_column(
        "campaigns",
        sa.Column("call_from_hour", sa.Integer(), nullable=False, server_default="9"),
    )
    op.add_column(
        "campaigns",
        sa.Column("call_to_hour", sa.Integer(), nullable=False, server_default="20"),
    )
    # Saturday (Monday=0), the default for an Israeli call centre.
    op.add_column(
        "campaigns",
        sa.Column(
            "quiet_weekdays",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[5]'::jsonb"),
        ),
    )
    op.create_check_constraint(
        "ck_campaigns_calling_window",
        "campaigns",
        "call_from_hour >= 0 AND call_from_hour <= 23 "
        "AND call_to_hour >= 1 AND call_to_hour <= 24 "
        "AND call_to_hour > call_from_hour",
    )

    # `next_attempt_at` third, before `position`: without it the claim walks
    # every pending row in position order checking the timestamp, which is a
    # full index scan whenever contacts are resting for a redial — measured at
    # 100,988 buffers over 50k rows, against 9 with this ordering.
    op.drop_index("ix_campaign_contacts_claim", table_name="campaign_contacts")
    op.create_index("ix_campaign_contacts_claim", "campaign_contacts", list(NEW_CLAIM))


def downgrade() -> None:
    op.drop_index("ix_campaign_contacts_claim", table_name="campaign_contacts")
    op.create_index("ix_campaign_contacts_claim", "campaign_contacts", list(OLD_CLAIM))
    op.drop_constraint("ck_campaigns_calling_window", "campaigns", type_="check")
    op.drop_column("campaigns", "quiet_weekdays")
    op.drop_column("campaigns", "call_to_hour")
    op.drop_column("campaigns", "call_from_hour")
    op.drop_column("campaigns", "timezone")

