"""index campaign_contacts.session_id

Every session read joins contacts by session_id to put a name beside the number,
and that runs on `POST /sessions` and `PATCH /sessions/{id}` too — so without
this index a call setup and a call finalize each sequentially scan the tenant's
whole contact table, on the latency-sensitive path, while the console polls the
list every ten seconds on top.

Revision ID: ea9aef9b2d14
Revises: 3b4a1c5307b4
Create Date: 2026-08-01
"""

from alembic import op

revision = "ea9aef9b2d14"
down_revision = "3b4a1c5307b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_campaign_contacts_session_id", "campaign_contacts", ["session_id"])


def downgrade() -> None:
    op.drop_index("ix_campaign_contacts_session_id", table_name="campaign_contacts")
