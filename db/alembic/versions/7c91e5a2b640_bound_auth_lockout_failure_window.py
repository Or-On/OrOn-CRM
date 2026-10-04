"""Do not extend an active account lock on unauthenticated failures.

Revision ID: 7c91e5a2b640
Revises: 9b2e7a4c6d18
"""

from alembic import op

revision = "7c91e5a2b640"
down_revision = "9b2e7a4c6d18"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # CREATE OR REPLACE preserves the existing owner and grants. The predicate
    # is rechecked after the row lock, including concurrent login failures.
    op.execute("""
        CREATE OR REPLACE FUNCTION platform.auth_record_login_failure(p_user_id uuid)
        RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER
        SET search_path = pg_catalog, platform
        AS $$
          UPDATE platform.auth_credentials
          SET failed_attempts = CASE WHEN locked_until IS NOT NULL
                                    THEN 1 ELSE failed_attempts + 1 END,
              locked_until = CASE
                WHEN locked_until IS NOT NULL THEN NULL
                WHEN failed_attempts + 1 >= 5
                  THEN CURRENT_TIMESTAMP + interval '15 minutes'
                ELSE NULL
              END,
              updated_at = CURRENT_TIMESTAMP
          WHERE user_id = p_user_id
            AND (locked_until IS NULL OR locked_until <= CURRENT_TIMESTAMP)
        $$
    """)


def downgrade() -> None:
    # Keep the security fix on application rollback; the function signature and
    # columns are unchanged and are compatible with the previous application.
    pass
