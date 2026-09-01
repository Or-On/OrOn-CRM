"""per-weekday calling hours

One from/to for the whole week plus a list of skipped days cannot say "Friday is
a short day", which in Israel it is. `weekday_hours` maps weekday -> [from, to]
and a missing day is a day nobody is called, so it replaces all three columns
rather than sitting beside them.

Existing campaigns keep exactly the window they had: every non-quiet day is
given the old from/to pair, and quiet days are simply left out of the map.

Revision ID: 0e01a2f68295
Revises: ea9aef9b2d14
Create Date: 2026-08-02
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0e01a2f68295"
down_revision = "ea9aef9b2d14"
branch_labels = None
depends_on = None

# Sunday-Thursday full, Friday short, Saturday closed. Keyed by weekday(), Mon=0.
DEFAULT = '{"6":[9,18],"0":[9,18],"1":[9,18],"2":[9,18],"3":[9,18],"4":[9,14]}'


def upgrade() -> None:
    op.add_column(
        "campaigns",
        sa.Column("weekday_hours", postgresql.JSONB(), nullable=False, server_default=DEFAULT),
    )
    # Carry the old window forward per day: jsonb_object_agg over the days that
    # were not quiet, so nothing silently starts calling on a day it did not.
    op.execute(
        """
        UPDATE campaigns SET weekday_hours = COALESCE(
            (
                SELECT jsonb_object_agg(d::text, jsonb_build_array(call_from_hour, call_to_hour))
                FROM generate_series(0, 6) AS d
                WHERE NOT (quiet_weekdays @> to_jsonb(d))
            ),
            '{}'::jsonb
        )
        """
    )
    op.drop_column("campaigns", "call_from_hour")
    op.drop_column("campaigns", "call_to_hour")
    op.drop_column("campaigns", "quiet_weekdays")


def downgrade() -> None:
    op.add_column(
        "campaigns", sa.Column("call_from_hour", sa.Integer(), nullable=False, server_default="9")
    )
    op.add_column(
        "campaigns", sa.Column("call_to_hour", sa.Integer(), nullable=False, server_default="18")
    )
    op.add_column(
        "campaigns",
        sa.Column("quiet_weekdays", postgresql.JSONB(), nullable=False, server_default="[5]"),
    )
    # Lossy by nature: a week with differing hours per day collapses to the
    # earliest start and latest end, and every day absent from the map is quiet.
    op.execute(
        """
        UPDATE campaigns SET
            call_from_hour = COALESCE((
                SELECT MIN((v->>0)::int) FROM jsonb_each(weekday_hours) AS e(k, v)
            ), 9),
            call_to_hour = COALESCE((
                SELECT MAX((v->>1)::int) FROM jsonb_each(weekday_hours) AS e(k, v)
            ), 20),
            quiet_weekdays = COALESCE((
                SELECT jsonb_agg(d) FROM generate_series(0, 6) AS d
                WHERE NOT weekday_hours ? d::text
            ), '[]'::jsonb)
        """
    )
    op.drop_column("campaigns", "weekday_hours")

