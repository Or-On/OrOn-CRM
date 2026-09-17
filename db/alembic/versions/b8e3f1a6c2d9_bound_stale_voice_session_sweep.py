"""bound the stale voice session sweep to one definer function

Revision ID: b8e3f1a6c2d9
Revises: d7a9e2c4f6b1
Create Date: 2026-09-17 18:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "b8e3f1a6c2d9"
down_revision: str | None = "d7a9e2c4f6b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The sweep is the last repair for a session no dispatcher could finalize.
    # It is one fixed statement: it cannot read a row, name a tenant, or touch
    # any other status. Granting only this to the voice role (which already
    # owns session lifecycle writes) keeps the historical Or-on login roles —
    # one of which still holds DML on users, memberships and api_keys — dormant.
    op.execute("""
        CREATE FUNCTION platform.fail_stale_voice_sessions(p_older_than_minutes integer)
        RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog AS $$
        DECLARE v_failed integer;
        BEGIN
          -- Below an hour a live call could be failed underneath itself.
          IF p_older_than_minutes IS NULL
             OR p_older_than_minutes < 60 OR p_older_than_minutes > 10080 THEN
            RAISE EXCEPTION 'stale session threshold out of range'
              USING ERRCODE = '22023';
          END IF;
          UPDATE public.sessions
          SET status = 'failed', ended_at = CURRENT_TIMESTAMP
          WHERE status = 'started'
            AND created_at < CURRENT_TIMESTAMP
              - make_interval(mins => p_older_than_minutes);
          GET DIAGNOSTICS v_failed = ROW_COUNT;
          RETURN v_failed;
        END
        $$
    """)
    op.execute("REVOKE ALL ON FUNCTION platform.fail_stale_voice_sessions(integer) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.fail_stale_voice_sessions(integer) TO platform_voice"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION platform.fail_stale_voice_sessions(integer)")
