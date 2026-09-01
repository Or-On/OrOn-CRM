"""Record the audio STT was actually sent.

STT cost was billed on `call_seconds`, an assumption. Pipecat 1.7 reports the
client-measured seconds each STT service received, so the row can carry the
number instead of deriving it.

Server default 0 rather than NULL: every existing row predates the meter, and
0 alongside a non-zero call_seconds is what tells you the meter is not running.

Revision ID: b38ef3c19979
Revises: 8eda5976c920
"""

import sqlalchemy as sa

from alembic import op

revision = "b38ef3c19979"
down_revision = "8eda5976c920"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("stt_audio_seconds", sa.Float(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("sessions", "stt_audio_seconds")

