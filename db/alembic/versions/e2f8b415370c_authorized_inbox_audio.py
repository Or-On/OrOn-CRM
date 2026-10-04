"""Expose validated audio through the existing tenant-authorized inbox media boundary.

Revision ID: e2f8b415370c
Revises: d1e7a304269b
"""

from alembic import op

revision = "e2f8b415370c"
down_revision = "d1e7a304269b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION messaging.current_tenant_message_media(p_message_id uuid)
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
            AND message.content_type IN ('image', 'document', 'audio')
            AND (
              (message.content_type = 'image' AND object.content_type IN (
                'image/jpeg', 'image/png', 'image/webp'
              ))
              OR (message.content_type = 'document'
                  AND object.content_type = 'application/pdf')
              OR (message.content_type = 'audio'
                  AND object.content_type IN ('audio/ogg', 'audio/wav'))
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
        """)


def downgrade() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION messaging.current_tenant_message_media(p_message_id uuid)
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
        """)
