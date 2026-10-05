"""Preserve active conversations across first opening-menu activation.

Record the first activation boundary so ongoing conversations are not restarted.
New conversations and the next 24-hour session boundary wait for a menu choice.
"""

from alembic import op

revision = "b162a7e4d903"
down_revision = "f0a61d9e82c4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS platform.whatsapp_opening_menu_legacy_sessions (
          tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
          channel_id uuid NOT NULL,
          provider_account_id text NOT NULL,
          conversation_id uuid NOT NULL,
          activated_at timestamptz NOT NULL,
          ownership_epoch bigint NOT NULL,
          anchor_received_at timestamptz NOT NULL,
          PRIMARY KEY(tenant_id,channel_id,conversation_id,activated_at),
          FOREIGN KEY(tenant_id,channel_id)
            REFERENCES messaging.channels(tenant_id,id) ON DELETE CASCADE,
          FOREIGN KEY(tenant_id,conversation_id)
            REFERENCES messaging.conversations(tenant_id,id) ON DELETE CASCADE
        )""",
        "ALTER TABLE platform.whatsapp_opening_menu_legacy_sessions ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE platform.whatsapp_opening_menu_legacy_sessions FORCE ROW LEVEL SECURITY",
        """DROP POLICY IF EXISTS opening_menu_legacy_tenant
          ON platform.whatsapp_opening_menu_legacy_sessions""",
        """CREATE POLICY opening_menu_legacy_tenant
          ON platform.whatsapp_opening_menu_legacy_sessions
          USING(tenant_id=platform.current_tenant_id())
          WITH CHECK(tenant_id=platform.current_tenant_id())""",
        """GRANT SELECT,INSERT ON platform.whatsapp_opening_menu_legacy_sessions
          TO platform_migrator""",
        """ALTER TABLE platform.whatsapp_opening_menu_configuration
          ADD COLUMN IF NOT EXISTS activated_at timestamptz""",
        """UPDATE platform.whatsapp_opening_menu_configuration
          SET activated_at='-infinity' WHERE enabled AND activated_at IS NULL""",
        """CREATE OR REPLACE FUNCTION platform.stamp_opening_menu_activation()
        RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
        DECLARE activating boolean;
        BEGIN
          activating:=NEW.enabled AND (TG_OP='INSERT' OR NOT OLD.enabled);
          IF NOT NEW.enabled THEN NEW.activated_at:=NULL;
          ELSIF TG_OP='INSERT' THEN NEW.activated_at:=clock_timestamp();
          ELSIF NOT OLD.enabled THEN NEW.activated_at:=clock_timestamp();
          ELSE NEW.activated_at:=OLD.activated_at;
          END IF;
          IF activating THEN
            INSERT INTO platform.whatsapp_opening_menu_legacy_sessions(
              tenant_id,channel_id,provider_account_id,conversation_id,
              activated_at,ownership_epoch,anchor_received_at)
            SELECT c.tenant_id,c.channel_id,channel.provider_account_id,c.id,
              NEW.activated_at,c.ownership_epoch,max(event.received_at)
            FROM messaging.conversations c
            JOIN messaging.channels channel ON channel.id=c.channel_id
              AND channel.tenant_id=c.tenant_id AND channel.provider='meta'
              AND channel.status='active'
            JOIN messaging.messages message ON message.tenant_id=c.tenant_id
              AND message.conversation_id=c.id AND message.direction='inbound'
              AND message.sender_type='contact' AND message.provider='meta'
              AND message.content_type<>'event'
            JOIN ops.inbound_events event ON event.tenant_id=c.tenant_id
              AND event.provider='meta'
              AND event.provider_account_id=channel.provider_account_id
              AND event.event_type LIKE 'whatsapp.message.%' AND event.status='processed'
              AND event.processed_at<NEW.activated_at AND event.received_at<NEW.activated_at
              AND event.payload->>'providerMessageId'=message.provider_message_id
            WHERE c.tenant_id=NEW.tenant_id AND c.channel_id=NEW.channel_id
              AND c.ownership_mode='ai' AND c.removed_from_inbox_at IS NULL
              AND c.ai_agent_profile_version_id=NEW.agent_version_id
            GROUP BY c.tenant_id,c.channel_id,channel.provider_account_id,c.id,c.ownership_epoch
            HAVING max(event.received_at)>NEW.activated_at-interval '24 hours'
            ON CONFLICT DO NOTHING;
          END IF;
          RETURN NEW;
        END $$""",
        """DROP TRIGGER IF EXISTS trg_opening_menu_activation
          ON platform.whatsapp_opening_menu_configuration""",
        """CREATE TRIGGER trg_opening_menu_activation BEFORE INSERT OR UPDATE
          ON platform.whatsapp_opening_menu_configuration FOR EACH ROW
          EXECUTE FUNCTION platform.stamp_opening_menu_activation()""",
        """CREATE OR REPLACE FUNCTION platform.opening_menu_legacy_session(p_conversation uuid)
        RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
        WITH scope AS (
          SELECT c.id,c.tenant_id,c.channel_id,cfg.activated_at,legacy.anchor_received_at
          FROM messaging.conversations c
          JOIN platform.whatsapp_opening_menu_configuration cfg
            ON cfg.tenant_id=c.tenant_id AND cfg.channel_id=c.channel_id
          JOIN platform.whatsapp_opening_menu_legacy_sessions legacy
            ON legacy.tenant_id=c.tenant_id AND legacy.channel_id=c.channel_id
            AND legacy.conversation_id=c.id AND legacy.activated_at=cfg.activated_at
            AND legacy.ownership_epoch=c.ownership_epoch
          JOIN messaging.channels channel ON channel.id=c.channel_id
            AND channel.tenant_id=c.tenant_id AND channel.provider='meta'
            AND channel.status='active'
            AND channel.provider_account_id=legacy.provider_account_id
          WHERE c.id=p_conversation AND c.tenant_id=platform.current_tenant_id()
            AND c.ownership_mode='ai' AND c.removed_from_inbox_at IS NULL
            AND c.ai_agent_profile_version_id=cfg.agent_version_id
            AND cfg.enabled AND cfg.activated_at IS NOT NULL
            AND c.created_at<cfg.activated_at AND isfinite(cfg.activated_at)
            AND coalesce(c.inbox_reopened_at,'-infinity'::timestamptz)<cfg.activated_at
            AND NOT EXISTS(SELECT 1 FROM platform.whatsapp_opening_menu_operations operation
              WHERE operation.tenant_id=c.tenant_id AND operation.conversation_id=c.id
                AND operation.decision->>'kind'='offer')
        ), receipts AS (
          SELECT message.id,min(event.received_at) AS received_at
          FROM scope
          JOIN messaging.channels channel ON channel.id=scope.channel_id
            AND channel.tenant_id=scope.tenant_id AND channel.provider='meta'
            AND channel.status='active'
          JOIN messaging.messages message ON message.tenant_id=scope.tenant_id
            AND message.conversation_id=scope.id AND message.direction='inbound'
            AND message.sender_type='contact' AND message.provider='meta'
            AND message.content_type<>'event'
          JOIN ops.inbound_events event ON event.tenant_id=scope.tenant_id
            AND event.provider='meta'
            AND event.provider_account_id=channel.provider_account_id
            AND event.event_type LIKE 'whatsapp.message.%'
            AND event.received_at>=scope.activated_at
            AND event.payload->>'providerMessageId'=message.provider_message_id
          GROUP BY message.id
          UNION ALL SELECT id,anchor_received_at FROM scope
        ), gaps AS (
          SELECT received_at,lag(received_at) OVER(ORDER BY received_at,id) AS previous_at
          FROM receipts
        )
        SELECT EXISTS(SELECT 1 FROM scope WHERE NOT EXISTS(
          SELECT 1 FROM gaps WHERE received_at>=scope.activated_at
            AND (previous_at IS NULL OR received_at-previous_at>=interval '24 hours')))
        $$""",
        "ALTER FUNCTION platform.stamp_opening_menu_activation() OWNER TO platform_migrator",
        "REVOKE ALL ON FUNCTION platform.stamp_opening_menu_activation() FROM PUBLIC",
        "ALTER FUNCTION platform.opening_menu_legacy_session(uuid) OWNER TO platform_migrator",
        "REVOKE ALL ON FUNCTION platform.opening_menu_legacy_session(uuid) FROM PUBLIC",
        """DO $migration$
        DECLARE signature text; definition text; original text; replacement text;
        BEGIN
          original:='IF NOT FOUND OR NOT cfg.enabled THEN';
          replacement:='IF NOT FOUND OR NOT cfg.enabled OR '
            ||'platform.opening_menu_legacy_session(c.id) THEN';
          FOREACH signature IN ARRAY ARRAY[
            'platform.opening_menu_scope(uuid,text,uuid)',
            'platform.opening_menu_business_job_allowed(uuid,text,uuid)'] LOOP
            definition:=pg_get_functiondef(signature::regprocedure);
            IF position(replacement IN definition)>0 THEN CONTINUE; END IF;
            IF (length(definition)-length(replace(definition,original,'')))
                /length(original)<>1 THEN
              RAISE EXCEPTION 'opening menu legacy boundary patch target changed';
            END IF;
            EXECUTE replace(definition,original,replacement);
          END LOOP;
          definition:=pg_get_functiondef('platform.opening_menu_tool_allowed(uuid,text)'::regprocedure);
          original:='SELECT NOT EXISTS(';
          replacement:='SELECT platform.opening_menu_legacy_session(p_conversation) OR NOT EXISTS(';
          IF position(replacement IN definition)=0 THEN
            IF (length(definition)-length(replace(definition,original,'')))
                /length(original)<>1 THEN
              RAISE EXCEPTION 'opening menu legacy tool patch target changed';
            END IF;
            EXECUTE replace(definition,original,replacement);
          END IF;
        END $migration$""",
    ]
    for statement in statements:
        op.execute(statement)


def downgrade() -> None:
    # Retain the additive contract during mixed-version rollback.
    pass
