"""add voice campaign policy foundation

Revision ID: 7beb64e1ff33
Revises: 315710614ae5
Create Date: 2026-09-02 13:26:26.083051
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "7beb64e1ff33"
down_revision: str | None = "315710614ae5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "contacts",
        sa.Column("voice_consent", sa.Text(), nullable=False, server_default="unknown"),
        schema="crm",
    )
    op.create_check_constraint(
        "ck_contacts_voice_consent",
        "contacts",
        "voice_consent IN ('unknown', 'granted', 'revoked')",
        schema="crm",
    )
    op.create_index(
        "ix_contacts_voice_campaign_eligibility",
        "contacts",
        ["tenant_id", "voice_consent", "lifecycle_status", "id"],
        schema="crm",
    )

    op.add_column(
        "campaigns", sa.Column("voice_flow_id", sa.UUID(), nullable=True), schema="platform"
    )
    op.add_column(
        "campaigns",
        sa.Column("max_concurrent", sa.Integer(), nullable=False, server_default="1"),
        schema="platform",
    )
    op.add_column(
        "campaigns",
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="1"),
        schema="platform",
    )
    op.add_column(
        "campaigns",
        sa.Column("timezone", sa.Text(), nullable=False, server_default="Asia/Jerusalem"),
        schema="platform",
    )
    op.add_column(
        "campaigns",
        sa.Column(
            "weekday_hours",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text(
                '\'{"0":[9,18],"1":[9,18],"2":[9,18],"3":[9,18],"4":[9,14],"6":[9,18]}\'::jsonb'
            ),
        ),
        schema="platform",
    )
    op.add_column(
        "campaigns",
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        schema="platform",
    )
    op.create_check_constraint(
        "ck_platform_campaign_voice_concurrency",
        "campaigns",
        "max_concurrent BETWEEN 1 AND 20",
        schema="platform",
    )
    op.create_check_constraint(
        "ck_platform_campaign_voice_attempts",
        "campaigns",
        "max_attempts BETWEEN 1 AND 5",
        schema="platform",
    )
    op.create_index(
        "ix_platform_voice_campaigns",
        "campaigns",
        ["tenant_id", "channel", "status", "id"],
        schema="platform",
        postgresql_where=sa.text("channel = 'voice'"),
    )
    op.execute("GRANT SELECT, INSERT, UPDATE ON platform.campaigns TO platform_voice")
    op.execute("GRANT SELECT, INSERT ON public.phone_numbers, public.flows TO platform_voice")


def downgrade() -> None:
    op.execute("REVOKE SELECT, INSERT ON public.phone_numbers, public.flows FROM platform_voice")
    op.execute("REVOKE SELECT, INSERT, UPDATE ON platform.campaigns FROM platform_voice")
    op.drop_index("ix_platform_voice_campaigns", table_name="campaigns", schema="platform")
    op.drop_constraint(
        "ck_platform_campaign_voice_attempts", "campaigns", schema="platform", type_="check"
    )
    op.drop_constraint(
        "ck_platform_campaign_voice_concurrency", "campaigns", schema="platform", type_="check"
    )
    for column in (
        "completed_at",
        "weekday_hours",
        "timezone",
        "max_attempts",
        "max_concurrent",
        "voice_flow_id",
    ):
        op.drop_column("campaigns", column, schema="platform")
    op.drop_index("ix_contacts_voice_campaign_eligibility", table_name="contacts", schema="crm")
    op.drop_constraint("ck_contacts_voice_consent", "contacts", schema="crm", type_="check")
    op.drop_column("contacts", "voice_consent", schema="crm")
