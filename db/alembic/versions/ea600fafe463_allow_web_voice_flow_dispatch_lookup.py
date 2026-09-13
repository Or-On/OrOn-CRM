"""allow web voice flow dispatch lookup

Revision ID: ea600fafe463
Revises: c718f92a2b71
Create Date: 2026-09-10 00:12:03.143389
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "ea600fafe463"
down_revision: str | None = "c718f92a2b71"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The same-origin web boundary validates a tenant-owned retained voice flow
    # before forwarding an explicitly approved call to the dispatcher. RLS on
    # public.flows continues to enforce the transaction-local tenant boundary.
    op.execute(sa.text("GRANT SELECT ON public.flows TO platform_web"))


def downgrade() -> None:
    op.execute(sa.text("REVOKE SELECT ON public.flows FROM platform_web"))
