"""expose tenant scoped message media

Revision ID: 4c8d2a7e9f10
Revises: 9b7e4c2d1a60
Create Date: 2026-09-15 22:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4c8d2a7e9f10"
down_revision: str | None = "9b7e4c2d1a60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_conversations_tenant_cursor",
        "conversations",
        ["tenant_id", sa.text("last_message_at DESC NULLS LAST"), sa.text("id DESC")],
        schema="messaging",
    )
    # Message objects are part of the tenant Inbox, independently of the
    # optional Field Service technician-object policy. Expose exactly one
    # object only through its owning inbound Meta message and current tenant.
    op.execute(
        """
        CREATE FUNCTION messaging.current_tenant_message_media(p_message_id uuid)
        RETURNS TABLE(
          id uuid,
          message_id uuid,
          content_type text,
          byte_size bigint,
          checksum text,
          storage_backend text,
          storage_key text,
          status text,
          file_name text
        )
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $$
          SELECT object.id, message.id, object.content_type,
                 object.byte_size, object.checksum,
                 object.storage_backend::text, object.storage_key,
                 object.status::text,
                 left(message.structured_content ->> 'fileName', 255)
          FROM messaging.messages message
          JOIN messaging.conversations conversation
            ON conversation.id = message.conversation_id
           AND conversation.tenant_id = message.tenant_id
          JOIN objects.object_metadata object
            ON object.id = message.object_id
           AND object.tenant_id = message.tenant_id
           AND object.owner_type = 'message'
           AND object.owner_id = message.id
          WHERE message.id = p_message_id
            AND message.tenant_id = platform.current_tenant_id()
            AND message.direction = 'inbound'
            AND message.provider = 'meta'
            AND message.content_type IN ('image', 'document')
            AND (
              (message.content_type = 'image' AND object.content_type IN (
                'image/jpeg', 'image/png', 'image/webp'
              ))
              OR (message.content_type = 'document'
                  AND object.content_type = 'application/pdf')
            )
            AND object.status = 'available'
            AND object.deleted_at IS NULL
            AND coalesce(current_setting('app.current_role', true), '')
                IN ('owner', 'admin', 'agent', 'viewer')
            AND EXISTS (
              SELECT 1
              FROM public.users actor
              JOIN public.tenants tenant
                ON tenant.id = message.tenant_id
               AND tenant.status = 'active'
              LEFT JOIN public.memberships membership
                ON membership.user_id = actor.id
               AND membership.tenant_id = message.tenant_id
              WHERE actor.id = platform.current_user_id()
                AND actor.status = 'active'
                AND (
                  actor.is_superuser
                  OR CASE membership.role
                       WHEN 'editor' THEN 'admin'
                       ELSE membership.role
                     END = current_setting('app.current_role', true)
                )
            )
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION messaging.current_tenant_message_media(uuid) FROM PUBLIC")
    op.execute(
        "GRANT EXECUTE ON FUNCTION messaging.current_tenant_message_media(uuid) TO platform_web"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION messaging.current_tenant_message_media(uuid)")
    op.drop_index(
        "ix_conversations_tenant_cursor",
        table_name="conversations",
        schema="messaging",
    )
