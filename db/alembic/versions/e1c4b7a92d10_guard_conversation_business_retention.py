"""Allow Inbox retention checks to inspect protected voice handoffs safely.

Revision ID: e1c4b7a92d10
Revises: d2f6b8a13c90

The web runtime must not read the voice identity table directly: it contains
protected verification state and is intentionally restricted to the voice role.
Conversation deletion nevertheless needs to know whether the conversation is
referenced there before attempting a hard delete. This tenant-bound definer
function exposes only a boolean and never returns identity data.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e1c4b7a92d10"
down_revision: str | None = "d2f6b8a13c90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION platform.conversation_has_voice_identity_verification(
          p_conversation_id uuid
        )
        RETURNS boolean
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path=pg_catalog,automation,platform
        AS $$
          SELECT EXISTS(
            SELECT 1
            FROM automation.voice_identity_verifications verification
            WHERE verification.tenant_id=platform.current_tenant_id()
              AND verification.conversation_id=p_conversation_id
          )
        $$
        """
    )
    op.execute(
        """
        REVOKE ALL ON FUNCTION platform.conversation_has_voice_identity_verification(uuid)
          FROM PUBLIC
        """
    )
    op.execute(
        """
        GRANT EXECUTE ON FUNCTION platform.conversation_has_voice_identity_verification(uuid)
          TO platform_web, platform_worker, platform_messaging
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP FUNCTION platform.conversation_has_voice_identity_verification(uuid)
        """
    )
