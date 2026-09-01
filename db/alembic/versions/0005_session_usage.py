"""Per-call usage counters on sessions.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

_COLUMNS = (
    ("call_seconds", sa.Float(), "0"),
    # Who carried the PSTN leg; rates differ per carrier and number type.
    ("carrier", sa.String(), "''"),
    # Which model billed. Configurable at runtime, so the row must say which
    # rate applies rather than the reader assuming today's config.
    ("llm_model", sa.String(), "''"),
    ("llm_prompt_tokens", sa.Integer(), "0"),
    ("llm_completion_tokens", sa.Integer(), "0"),
    ("tts_model", sa.String(), "''"),
    ("tts_characters", sa.Integer(), "0"),
    ("tts_audio_seconds", sa.Float(), "0"),
)


def upgrade() -> None:
    # NOT NULL with a server default: existing rows genuinely consumed nothing
    # we recorded, and zero reads correctly in a SUM where NULL would poison it.
    for name, type_, default in _COLUMNS:
        op.add_column(
            "sessions",
            sa.Column(name, type_, nullable=False, server_default=sa.text(default)),
        )


def downgrade() -> None:
    for name, _, _ in reversed(_COLUMNS):
        op.drop_column("sessions", name)
