"""grant messaging worker support investigation access

Revision ID: 3cbd28bebf1a
Revises: 143c59f3c8e2
Create Date: 2026-09-13 19:20:13.983681
"""

from collections.abc import Sequence

from alembic import op

revision: str = "3cbd28bebf1a"
down_revision: str | None = "143c59f3c8e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The messaging worker may investigate only rows visible through the
    # tables' existing tenant RLS policies.  These grants add the minimum CRUD
    # needed to read prior evidence and create a durable CRM ticket at handoff.
    op.execute("GRANT SELECT ON crm.notes, public.sessions TO platform_messaging")
    op.execute("GRANT SELECT, INSERT ON crm.tasks TO platform_messaging")
    op.execute("GRANT SELECT, INSERT ON crm.notes TO platform_messaging")


def downgrade() -> None:
    op.execute("REVOKE SELECT, INSERT ON crm.notes FROM platform_messaging")
    op.execute("REVOKE SELECT, INSERT ON crm.tasks FROM platform_messaging")
    op.execute("REVOKE SELECT ON public.sessions FROM platform_messaging")
