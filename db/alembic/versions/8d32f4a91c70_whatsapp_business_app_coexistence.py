"""Durable, account-bound WhatsApp Business App Coexistence receipts.

Revision ID: 8d32f4a91c70
Revises: 7c91e5a2b640
"""

# ruff: noqa: E501 -- migration-owned SQL declarations, consistent with adjacent revisions.
from alembic import op

revision = "8d32f4a91c70"
down_revision = "7c91e5a2b640"
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


def _claim(coexistence: bool):
    extra = (
        ",'whatsapp.coexistence.account_update','whatsapp.coexistence.history',"
        "'whatsapp.coexistence.smb_app_state_sync','whatsapp.coexistence.smb_message_echoes'"
        if coexistence
        else ""
    )
    op.execute(f"""CREATE OR REPLACE FUNCTION ops.claim_inbound_events(
      p_worker_id text,p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT 300)
      RETURNS SETOF ops.inbound_events LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog AS $$
        WITH candidates AS (
          SELECT id FROM ops.inbound_events WHERE attempts<max_attempts
            AND provider='meta' AND tenant_id IS NOT NULL
            AND event_type IN ('whatsapp.message.text','whatsapp.message.image',
              'whatsapp.message.document','whatsapp.message.location','whatsapp.message.status',
              'whatsapp.message.audio','whatsapp.message.video',
              'whatsapp.message.interactive','whatsapp.message.event'{extra})
            AND ((status IN ('received','failed') AND available_at<=CURRENT_TIMESTAMP)
              OR (status='processing' AND locked_at<CURRENT_TIMESTAMP
                - make_interval(secs=>GREATEST(1,p_lease_seconds))))
          ORDER BY available_at,received_at,receipt_sequence FOR UPDATE SKIP LOCKED
          LIMIT LEAST(GREATEST(p_limit,1),100)
        ) UPDATE ops.inbound_events event SET status='processing',attempts=event.attempts+1,
          locked_at=CURRENT_TIMESTAMP,locked_by=p_worker_id FROM candidates
          WHERE event.id=candidates.id RETURNING event.*
      $$""")  # noqa: S608 - closed migration constants only


def upgrade():
    _execute_statements("""
      CREATE TABLE platform.whatsapp_coexistence_accounts(
        tenant_id uuid NOT NULL,
        channel_id uuid NOT NULL,
        waba_id text NOT NULL CHECK(waba_id ~ '^[0-9]+$'),
        phone_number_id text NOT NULL UNIQUE CHECK(phone_number_id ~ '^[0-9]+$'),
        business_phone_number text NOT NULL CHECK(business_phone_number ~ '^[1-9][0-9]{6,14}$'),
        enabled boolean NOT NULL DEFAULT false,
        disconnected_at timestamptz,
        last_account_event text,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(tenant_id,channel_id),
        FOREIGN KEY(tenant_id,channel_id) REFERENCES messaging.channels(tenant_id,id) ON DELETE CASCADE
      );
      ALTER TABLE platform.whatsapp_coexistence_accounts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE platform.whatsapp_coexistence_accounts FORCE ROW LEVEL SECURITY;
      CREATE POLICY coexistence_account_read ON platform.whatsapp_coexistence_accounts
        FOR SELECT USING(tenant_id=platform.current_tenant_id());
      GRANT SELECT ON platform.whatsapp_coexistence_accounts TO platform_web,platform_messaging;
      -- Activation/binding is a reviewed deployment operation. Neither runtime
      -- role can choose a different WABA or enable importing by direct DML.
      CREATE TABLE messaging.whatsapp_app_contacts(
        tenant_id uuid NOT NULL,
        channel_id uuid NOT NULL,
        phone_number text NOT NULL,
        contact_id uuid,
        display_name text NOT NULL DEFAULT '',
        state text NOT NULL CHECK(state IN ('add','remove')),
        provider_timestamp timestamptz NOT NULL,
        PRIMARY KEY(tenant_id,channel_id,phone_number),
        FOREIGN KEY(tenant_id,channel_id) REFERENCES platform.whatsapp_coexistence_accounts(tenant_id,channel_id) ON DELETE CASCADE,
        FOREIGN KEY(tenant_id,contact_id) REFERENCES crm.contacts(tenant_id,id) ON DELETE SET NULL (contact_id)
      );
      ALTER TABLE messaging.whatsapp_app_contacts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE messaging.whatsapp_app_contacts FORCE ROW LEVEL SECURITY;
      CREATE POLICY coexistence_contact_isolation ON messaging.whatsapp_app_contacts
        USING(tenant_id=platform.current_tenant_id()) WITH CHECK(tenant_id=platform.current_tenant_id());
      GRANT SELECT ON messaging.whatsapp_app_contacts TO platform_web;
      GRANT SELECT,INSERT,UPDATE ON messaging.whatsapp_app_contacts TO platform_messaging;

      CREATE FUNCTION ops.accept_whatsapp_coexistence(
        p_waba text,p_phone text,p_event_id text,p_field text,p_value jsonb,p_digest text)
      RETURNS ops.inbound_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE binding platform.whatsapp_coexistence_accounts; receipt ops.inbound_events;
        echo jsonb; customer text;
      BEGIN
        IF p_field NOT IN ('account_update','history','smb_app_state_sync','smb_message_echoes')
          OR p_event_id NOT LIKE 'coexistence:' || p_field || ':%'
          OR p_digest !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_value)<>'object'
          THEN RAISE EXCEPTION 'invalid coexistence receipt' USING ERRCODE='22023'; END IF;
        SELECT account.* INTO binding FROM platform.whatsapp_coexistence_accounts account
          JOIN messaging.channels channel ON channel.tenant_id=account.tenant_id AND channel.id=account.channel_id
          JOIN public.tenants tenant ON tenant.id=account.tenant_id
          WHERE account.waba_id=p_waba AND account.phone_number_id=p_phone
            AND channel.kind='whatsapp' AND channel.provider='meta'
            AND channel.provider_account_id=p_phone AND tenant.status='active'
            FOR UPDATE OF channel,account;
        IF NOT FOUND THEN RAISE EXCEPTION 'unknown WhatsApp coexistence binding' USING ERRCODE='22023'; END IF;
        IF (p_field<>'account_update' AND p_value#>>'{metadata,phone_number_id}' IS DISTINCT FROM p_phone)
          OR (p_value ? 'phone_number' AND regexp_replace(p_value->>'phone_number','^\\+','') IS DISTINCT FROM binding.business_phone_number)
          THEN RAISE EXCEPTION 'WhatsApp coexistence account mismatch' USING ERRCODE='22023'; END IF;
        INSERT INTO ops.inbound_events(tenant_id,provider,provider_account_id,provider_event_id,event_type,payload)
          VALUES(binding.tenant_id,'meta',p_phone,p_event_id,'whatsapp.coexistence.'||p_field,
            jsonb_build_object('wabaId',p_waba,'providerAccountId',p_phone,'field',p_field,'value',p_value,'rawBodySha256',p_digest,'receiptId',p_event_id,'importEnabled',binding.enabled))
          ON CONFLICT(provider,provider_account_id,provider_event_id) DO NOTHING
          RETURNING * INTO receipt;
        IF NOT FOUND THEN
          SELECT * INTO STRICT receipt FROM ops.inbound_events WHERE provider='meta'
            AND provider_account_id=p_phone AND provider_event_id=p_event_id;
          RETURN receipt;
        END IF;
        IF p_field='account_update' AND p_value->>'event' IN ('PARTNER_REMOVED','ACCOUNT_OFFBOARDED') THEN
          UPDATE messaging.channels SET status='revoked',updated_at=CURRENT_TIMESTAMP
            WHERE tenant_id=binding.tenant_id AND id=binding.channel_id;
          UPDATE platform.whatsapp_coexistence_accounts SET disconnected_at=COALESCE(disconnected_at,CURRENT_TIMESTAMP),last_account_event=p_value->>'event'
            WHERE tenant_id=binding.tenant_id AND channel_id=binding.channel_id;
        ELSIF p_field='account_update' THEN
          UPDATE platform.whatsapp_coexistence_accounts SET last_account_event=left(p_value->>'event',100)
            WHERE tenant_id=binding.tenant_id AND channel_id=binding.channel_id;
        ELSIF p_field='smb_message_echoes' AND binding.enabled AND binding.disconnected_at IS NULL THEN
          -- Fence in the durable receipt transaction, before an already-running
          -- model can pass its final ownership check. Cloud sends retain ownership.
          FOR echo IN SELECT value FROM jsonb_array_elements(COALESCE(p_value->'message_echoes','[]')) LOOP
            customer:=regexp_replace(echo->>'to','^\\+','');
            IF regexp_replace(echo->>'from','^\\+','')=binding.business_phone_number
              AND customer ~ '^[1-9][0-9]{6,14}$' AND NULLIF(echo->>'id','') IS NOT NULL THEN
              UPDATE messaging.conversations conversation SET ownership_mode='human',ownership_epoch=ownership_epoch+1,updated_at=CURRENT_TIMESTAMP
                WHERE conversation.tenant_id=binding.tenant_id AND conversation.channel_id=binding.channel_id
                  AND conversation.ownership_mode<>'human'
                  AND EXISTS(SELECT 1 FROM crm.contact_channel_identities identity WHERE identity.tenant_id=conversation.tenant_id
                    AND identity.contact_id=conversation.contact_id AND identity.channel='whatsapp' AND identity.normalized_value='+'||customer)
                  AND NOT EXISTS(SELECT 1 FROM messaging.messages message WHERE message.tenant_id=binding.tenant_id
                    AND message.provider='meta' AND message.provider_message_id=echo->>'id');
            END IF;
          END LOOP;
        END IF;
        RETURN receipt;
      END $$;
      REVOKE ALL ON FUNCTION ops.accept_whatsapp_coexistence(text,text,text,text,jsonb,text) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ops.accept_whatsapp_coexistence(text,text,text,text,jsonb,text) TO platform_web;
    """)
    _claim(True)


def downgrade():
    _claim(False)
    op.execute("DROP FUNCTION ops.accept_whatsapp_coexistence(text,text,text,text,jsonb,text)")
    op.execute("DROP TABLE messaging.whatsapp_app_contacts")
    op.execute("DROP TABLE platform.whatsapp_coexistence_accounts")
