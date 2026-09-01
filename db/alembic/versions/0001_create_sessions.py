"""create sessions table

Revision ID: 0001
Revises:
Create Date: 2026-07-16

"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

direction = postgresql.ENUM("inbound", "outbound", name="direction")
session_status = postgresql.ENUM("started", "ended", "failed", name="sessionstatus")


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("session_id", sa.Uuid(), primary_key=True),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("direction", direction, nullable=False),
        sa.Column("from_number", sa.String(), nullable=True),
        sa.Column("to_number", sa.String(), nullable=True),
        sa.Column("room", sa.String(), nullable=False),
        sa.Column("status", session_status, nullable=False),
        sa.Column("recording_uri", sa.String(), nullable=True),
        sa.Column("transcript_uri", sa.String(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("recording_uri <> ''", name="ck_sessions_recording_uri_nonempty"),
        sa.CheckConstraint("transcript_uri <> ''", name="ck_sessions_transcript_uri_nonempty"),
    )


def downgrade() -> None:
    op.drop_table("sessions")
    # The enum types outlive the table; drop them explicitly.
    direction.drop(op.get_bind())
    session_status.drop(op.get_bind())

