"""Do not renew an active account lock on repeated or concurrent login failures.

Revision ID: a14d0c8e2b77
Revises: 9b2e7a4c6d18
"""

from alembic import op

revision = "a14d0c8e2b77"
down_revision = "9b2e7a4c6d18"
branch_labels = None
depends_on = None


def _replace_failure_function(*, preserve_active_lock: bool) -> None:
    guard = (
        "AND (locked_until IS NULL OR locked_until <= CURRENT_TIMESTAMP)"
        if preserve_active_lock
        else ""
    )
    # Only migration-owned constants enter this statement. CREATE OR REPLACE
    # preserves the existing function owner and grants.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION platform.auth_record_login_failure(p_user_id uuid)
        RETURNS void
        LANGUAGE sql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, platform
        AS $$
          UPDATE platform.auth_credentials
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE
                WHEN failed_attempts + 1 >= 5 THEN CURRENT_TIMESTAMP + interval '15 minutes'
                ELSE locked_until
              END,
              updated_at = CURRENT_TIMESTAMP
          WHERE user_id = p_user_id
        """  # noqa: S608 -- only fixed migration-owned constants.
        + guard
        + "\n$$"
    )


def upgrade() -> None:
    _replace_failure_function(preserve_active_lock=True)


def downgrade() -> None:
    _replace_failure_function(preserve_active_lock=False)
