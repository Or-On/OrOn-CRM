"""grant voice webhook ledger access

Revision ID: 315710614ae5
Revises: e24340ce81c8
Create Date: 2026-09-02
"""

from collections.abc import Sequence

from alembic import op

revision: str = "315710614ae5"
down_revision: str | None = "e24340ce81c8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # LiveKit signs before tenant/DID resolution, so the durable provider
    # envelope is intentionally global (tenant_id NULL). The voice role can
    # claim only this existing event ledger; it gains no worker/job authority.
    op.execute("GRANT SELECT, INSERT, UPDATE ON ops.inbound_events TO platform_voice")


def downgrade() -> None:
    op.execute("REVOKE SELECT, INSERT, UPDATE ON ops.inbound_events FROM platform_voice")
