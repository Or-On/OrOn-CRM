"""Mark when a removed Inbox conversation was reopened by a new customer message.

Revision ID: f3a8c61e4b27
Revises: e1c4b7a92d10

Removing an evidence-linked conversation keeps its row, and the next inbound
message reopens that same row. Work that belongs to the removed thread, such as
a field-service intake that ended with a person, must not drive the reopened
thread: the AI escalated every new message straight back to a human. The
timestamp bounds that state; NULL means the conversation was never reopened.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "f3a8c61e4b27"
down_revision: str | None = "e1c4b7a92d10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE messaging.conversations ADD COLUMN inbox_reopened_at timestamptz")


def downgrade() -> None:
    op.execute("ALTER TABLE messaging.conversations DROP COLUMN inbox_reopened_at")
