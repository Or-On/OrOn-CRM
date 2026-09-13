"""backfill unread whatsapp notifications

Revision ID: 143c59f3c8e2
Revises: c9f996d8be8e
Create Date: 2026-09-13 01:02:11.515463
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "143c59f3c8e2"
down_revision: str | None = "c9f996d8be8e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Surface already-accepted unread Meta conversations in the new durable
    # notification center. The payload intentionally contains neither message
    # text nor contact identity, and never admits or replays AI work.
    op.execute(
        sa.text(
            """
            INSERT INTO messaging.notifications
              (tenant_id, user_id, type, title, body, reference_type, reference_id)
            SELECT conversation.tenant_id, membership.user_id,
                   'whatsapp.inbound.backfill', 'New WhatsApp message',
                   'A customer message is waiting in the Inbox.',
                   'conversation', conversation.id
            FROM messaging.conversations conversation
            JOIN messaging.channels channel
              ON channel.id=conversation.channel_id
             AND channel.tenant_id=conversation.tenant_id
             AND channel.kind='whatsapp'
             AND channel.provider='meta'
            JOIN public.memberships membership
              ON membership.tenant_id=conversation.tenant_id
             AND membership.role IN ('owner','admin','editor','agent')
            JOIN public.users account
              ON account.id=membership.user_id AND account.status='active'
            WHERE conversation.unread_count > 0
              AND NOT EXISTS (
                SELECT 1 FROM messaging.notifications existing
                WHERE existing.tenant_id=conversation.tenant_id
                  AND existing.user_id=membership.user_id
                  AND existing.reference_type='conversation'
                  AND existing.reference_id=conversation.id
                  AND existing.type LIKE 'whatsapp.inbound%'
                  AND existing.read_at IS NULL
              )
            """
        )
    )


def downgrade() -> None:
    op.execute("DELETE FROM messaging.notifications WHERE type='whatsapp.inbound.backfill'")
