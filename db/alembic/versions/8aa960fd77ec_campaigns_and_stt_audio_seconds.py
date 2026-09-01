"""Rejoin the campaign and STT-billing branches.

Empty by design — a merge revision carries no DDL. It exists because #61 branched
off `ea9aef9b2d14` and #72 off `8eda5976c920`, so master ended with two heads and
`alembic upgrade head` failed for everyone. The compose `migrate` one-shot runs
exactly that, and both `sessions` and `dispatcher` gate on it completing, so the
whole stack would have refused to start on the next deploy.

Neither PR could catch it: each had a single head for as long as it was open.

Revision ID: 8aa960fd77ec
Revises: 0e01a2f68295, b38ef3c19979
"""

revision = "8aa960fd77ec"
down_revision = ("0e01a2f68295", "b38ef3c19979")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
