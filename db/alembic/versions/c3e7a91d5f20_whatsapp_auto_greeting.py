"""Per-channel automatic WhatsApp greeting template for new conversations.

An administrator chooses one approved template name for a WhatsApp channel.
The languages it is approved in are recorded when the setting is saved, so
the messaging worker can choose the customer's language without a provider
call. Disabled until an administrator enables it.

Revision ID: c3e7a91d5f20
Revises: af54b6c13e92
"""

# ruff: noqa: E501 -- migration-owned SQL declarations, consistent with adjacent revisions.
from alembic import op

revision = "c3e7a91d5f20"
down_revision = "af54b6c13e92"
branch_labels = None
depends_on = None


def _execute_statements(script: str) -> None:
    pending = ""
    for index, part in enumerate(script.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
            continue
        pieces = part.split(";")
        pending += pieces[0]
        for piece in pieces[1:]:
            if pending.strip():
                op.execute(pending)
            pending = piece
    if pending.strip():
        op.execute(pending)


def upgrade() -> None:
    _execute_statements("""
      CREATE TABLE messaging.whatsapp_auto_greetings(
        tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
        channel_id uuid NOT NULL,
        enabled boolean NOT NULL DEFAULT false,
        template_name text NOT NULL CHECK(char_length(template_name) BETWEEN 1 AND 512 AND template_name ~ '^[a-z0-9_]+$'),
        languages text[] NOT NULL CHECK(cardinality(languages) BETWEEN 1 AND 20
          AND array_to_string(languages,',') ~ '^[a-z]{2,3}(_[A-Z]{2})?(,[a-z]{2,3}(_[A-Z]{2})?)*$'),
        fallback_language text NOT NULL,
        updated_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY(tenant_id,channel_id),
        FOREIGN KEY(tenant_id,channel_id) REFERENCES messaging.channels(tenant_id,id) ON DELETE CASCADE,
        CONSTRAINT ck_whatsapp_auto_greeting_fallback CHECK(fallback_language=ANY(languages))
      );
      ALTER TABLE messaging.whatsapp_auto_greetings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE messaging.whatsapp_auto_greetings FORCE ROW LEVEL SECURITY;
      CREATE POLICY whatsapp_auto_greeting_tenant ON messaging.whatsapp_auto_greetings
        USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
      GRANT SELECT,INSERT,UPDATE ON messaging.whatsapp_auto_greetings TO platform_web;
      GRANT SELECT ON messaging.whatsapp_auto_greetings TO platform_messaging;
      GRANT SELECT,INSERT,UPDATE,DELETE ON messaging.whatsapp_auto_greetings TO platform_migrator;

      -- The greeting decision for one committed inbound message. A message
      -- starts a new conversation when no other message of the thread, in
      -- either direction, falls within the 24 hours before it (a reopened
      -- Inbox thread starts at its reopen time). A channel whose opening
      -- menu is enabled already sends its own first template. The sender is
      -- the administrator who saved the setting, re-authorised on every use.
      CREATE FUNCTION messaging.auto_greeting_for_inbound(p_message uuid) RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        SELECT jsonb_build_object('conversationId',conversation.id,'templateName',greeting.template_name,
          'languages',to_jsonb(greeting.languages),'fallbackLanguage',greeting.fallback_language,
          'actorUserId',greeting.updated_by_user_id,'text',coalesce(message.content_text,''),
          'provider',channel.provider,'channelConfiguration',channel.configuration)
        FROM messaging.messages message
        JOIN messaging.conversations conversation
          ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id
        JOIN messaging.channels channel
          ON channel.tenant_id=conversation.tenant_id AND channel.id=conversation.channel_id
        JOIN messaging.whatsapp_auto_greetings greeting
          ON greeting.tenant_id=channel.tenant_id AND greeting.channel_id=channel.id AND greeting.enabled
        WHERE message.tenant_id=platform.current_tenant_id() AND message.id=p_message
          AND message.direction='inbound' AND message.content_type<>'event'
          AND channel.kind='whatsapp' AND channel.status='active'
          AND conversation.removed_from_inbox_at IS NULL
          AND greeting.updated_by_user_id IS NOT NULL
          AND platform.messaging_ai_actor_authorized(greeting.updated_by_user_id)
          AND platform.current_tenant_feature_enabled('whatsapp')
          AND NOT EXISTS(SELECT 1 FROM platform.whatsapp_opening_menu_configuration menu
            WHERE menu.tenant_id=channel.tenant_id AND menu.channel_id=channel.id AND menu.enabled)
          AND NOT EXISTS(SELECT 1 FROM messaging.messages earlier
            WHERE earlier.tenant_id=message.tenant_id AND earlier.conversation_id=message.conversation_id
              AND earlier.id<>message.id AND earlier.content_type<>'event'
              AND earlier.created_at>=message.created_at-interval '24 hours'
              AND earlier.created_at>=coalesce(conversation.inbox_reopened_at,'-infinity'::timestamptz))
      $$;
      REVOKE ALL ON FUNCTION messaging.auto_greeting_for_inbound(uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION messaging.auto_greeting_for_inbound(uuid) TO platform_messaging
    """)


def downgrade() -> None:
    op.execute("DROP FUNCTION messaging.auto_greeting_for_inbound(uuid)")
    op.execute("DROP TABLE messaging.whatsapp_auto_greetings")
