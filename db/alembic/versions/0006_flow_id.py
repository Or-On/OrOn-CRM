"""flow_id (required) on phone_numbers and sessions

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-25
"""

import sqlalchemy as sa

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

# oron_agent.flows_seed.EXAMPLE_HE_ID, copied rather than imported: a migration is
# a historical snapshot, so changing the constant must not rewrite what this ran.
# test_legacy_backfill_is_the_packaged_flow keeps the two in step.
PACKAGED_HE_FLOW_ID = "0000f10d-0000-4000-8000-000000000001"
# Sessions predating the binding: nobody recorded which flow they ran, and a
# plausible guess would be a lie exactly where analytics reads it.
UNKNOWN_FLOW_ID = "00000000-0000-0000-0000-000000000000"


def _add_required_uuid(table: str, column: str, backfill: str) -> None:
    """Add a NOT NULL column without rewriting the table.

    Since PG 11 `ADD COLUMN ... NOT NULL DEFAULT <const>` is a catalog update;
    add-nullable/UPDATE/SET-NOT-NULL rewrites every row and holds the table
    locked meanwhile. `sessions` grows one row per call forever.
    """
    op.execute(
        sa.text(f"ALTER TABLE {table} ADD COLUMN {column} uuid NOT NULL DEFAULT '{backfill}'")
    )
    op.execute(sa.text(f"ALTER TABLE {table} ALTER COLUMN {column} DROP DEFAULT"))


def upgrade() -> None:
    # Registered DIDs keep answering with the flow they were already running.
    _add_required_uuid("phone_numbers", "flow_id", PACKAGED_HE_FLOW_ID)
    _add_required_uuid("sessions", "flow_id", UNKNOWN_FLOW_ID)


def downgrade() -> None:
    op.drop_column("sessions", "flow_id")
    op.drop_column("phone_numbers", "flow_id")

