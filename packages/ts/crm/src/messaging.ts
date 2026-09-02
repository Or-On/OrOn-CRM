import { createHash, randomUUID } from "node:crypto";

import type postgres from "postgres";

import { normalizeE164 } from "./phone.js";
import type {
  ConversationSummary,
  Message,
  SimulatedInboundInput,
  SimulatedOutboundInput,
  QuickReply,
} from "./types.js";
import type { WhatsAppInboundEnvelope } from "./webhook.js";
import type { WhatsAppStatusEnvelope } from "./webhook.js";

interface ConversationRow {
  id: string;
  contact_id: string;
  contact_name: string;
  status: ConversationSummary["status"];
  unread_count: number;
  last_message_at: Date | null;
  last_message_preview: string | null;
  assigned_user_id: string | null;
  channel_kind: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  direction: Message["direction"];
  sender_type: Message["senderType"];
  content_type: string;
  content_text: string | null;
  status: string;
  provider_message_id: string | null;
  created_at: Date;
  reactions: unknown;
  delivery_events: unknown;
}

function deliveryEvents(value: unknown): Message["deliveryEvents"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as Readonly<Record<string, unknown>>;
    return typeof record.status === "string" &&
      typeof record.occurredAt === "string"
      ? [{ status: record.status, occurredAt: record.occurredAt }]
      : [];
  });
}

function mapConversation(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    status: row.status,
    unreadCount: row.unread_count,
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
    lastMessagePreview: row.last_message_preview,
    assignedUserId: row.assigned_user_id,
    channelKind: row.channel_kind,
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    senderType: row.sender_type,
    contentType: row.content_type,
    contentText: row.content_text,
    status: row.status,
    providerMessageId: row.provider_message_id,
    createdAt: row.created_at.toISOString(),
    reactions: Array.isArray(row.reactions)
      ? row.reactions.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    deliveryEvents: deliveryEvents(row.delivery_events),
  };
}

export async function listConversations(
  sql: postgres.TransactionSql,
): Promise<readonly ConversationSummary[]> {
  const rows = await sql<ConversationRow[]>`
    SELECT c.id, c.contact_id, contact.name AS contact_name, c.status,
           c.unread_count, c.last_message_at, c.last_message_preview,
           c.assigned_user_id, channel.kind AS channel_kind
    FROM messaging.conversations c
    JOIN crm.contacts contact ON contact.id = c.contact_id
    JOIN messaging.channels channel ON channel.id = c.channel_id
    ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
    LIMIT 100
  `;
  return rows.map(mapConversation);
}

export async function listMessages(
  sql: postgres.TransactionSql,
  conversationId: string,
): Promise<readonly Message[]> {
  const rows = await sql<MessageRow[]>`
    SELECT message.id, message.conversation_id, message.direction,
           message.sender_type, message.content_type, message.content_text,
           message.status, message.provider_message_id, message.created_at,
           COALESCE((SELECT jsonb_agg(reaction.emoji ORDER BY reaction.created_at)
                     FROM messaging.message_reactions reaction
                     WHERE reaction.message_id = message.id), '[]') AS reactions
           , COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'status', delivery.status,
                        'occurredAt', delivery.occurred_at
                      ) ORDER BY delivery.occurred_at, delivery.id)
                     FROM messaging.message_delivery_events delivery
                     WHERE delivery.message_id = message.id), '[]') AS delivery_events
    FROM messaging.messages message
    WHERE message.conversation_id = ${conversationId}::uuid
    ORDER BY created_at ASC, id ASC
    LIMIT 250
  `;
  return rows.map(mapMessage);
}

async function simulatorChannelId(
  sql: postgres.TransactionSql,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO messaging.channels
      (tenant_id, kind, provider, provider_account_id, display_address, status,
       configuration)
    VALUES (platform.current_tenant_id(), 'whatsapp', 'simulator',
            'simulator:' || platform.current_tenant_id()::text,
            'WhatsApp simulator', 'active', '{"mode":"simulator"}'::jsonb)
    ON CONFLICT (provider, provider_account_id) WHERE provider_account_id IS NOT NULL
    DO UPDATE SET status = 'active', updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("simulator channel resolution failed");
  return id;
}

export async function ingestSimulatedInbound(
  sql: postgres.TransactionSql,
  actorUserId: string,
  input: SimulatedInboundInput,
): Promise<{ readonly conversationId: string; readonly inserted: boolean }> {
  const phone = normalizeE164(input.from);
  if (phone === undefined)
    throw new TypeError("simulator sender must use E.164");
  if (input.text.trim() === "") throw new TypeError("message text is required");
  const occurredAt = input.occurredAt ?? new Date();
  const channelId = await simulatorChannelId(sql);

  const identityRows = await sql<{ contact_id: string }[]>`
    SELECT contact_id FROM crm.contact_channel_identities
    WHERE channel = 'whatsapp' AND normalized_value = ${phone}
    LIMIT 1
  `;
  let contactId = identityRows[0]?.contact_id;
  if (contactId === undefined) {
    const contactRows = await sql<{ id: string }[]>`
      INSERT INTO crm.contacts
        (tenant_id, created_by_user_id, name, last_activity_at)
      VALUES (platform.current_tenant_id(), ${actorUserId}::uuid,
              ${input.profileName.trim() || phone}, ${occurredAt})
      RETURNING id
    `;
    contactId = contactRows[0]?.id;
    if (contactId === undefined)
      throw new Error("inbound contact insert failed");
    await sql`
      INSERT INTO crm.contact_channel_identities
        (tenant_id, contact_id, channel, normalized_value, display_value,
         provider, provider_identity_id, validation_status, is_primary)
      VALUES (platform.current_tenant_id(), ${contactId}::uuid, 'whatsapp',
              ${phone}, ${input.from}, 'simulator', ${phone}, 'valid', true)
    `;
  } else {
    await sql`
      UPDATE crm.contacts SET name = ${input.profileName.trim() || phone},
             last_activity_at = ${occurredAt}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${contactId}::uuid
    `;
  }

  const conversationRows = await sql<{ id: string }[]>`
    INSERT INTO messaging.conversations
      (tenant_id, channel_id, contact_id, status, unread_count,
       last_message_at, last_message_preview)
    VALUES (platform.current_tenant_id(), ${channelId}::uuid, ${contactId}::uuid,
            'open', 0, NULL, NULL)
    ON CONFLICT (tenant_id, channel_id, contact_id)
    DO UPDATE SET status = 'open',
                  updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `;
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined)
    throw new Error("conversation resolution failed");
  const messageRows = await sql<{ id: string }[]>`
    INSERT INTO messaging.messages
      (tenant_id, conversation_id, direction, sender_type, sender_contact_id,
       content_type, content_text, provider, provider_message_id, status,
       provider_payload, created_at)
    VALUES (platform.current_tenant_id(), ${conversationId}::uuid, 'inbound',
            'contact', ${contactId}::uuid, 'text', ${input.text.trim()},
            'simulator', ${input.providerMessageId}, 'received',
            ${sql.json({
              source: "whatsapp_simulator",
              providerEventId: input.providerEventId,
            })}, ${occurredAt})
    ON CONFLICT (tenant_id, provider, provider_message_id)
      WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL
    DO NOTHING
    RETURNING id
  `;
  const insertedMessageId = messageRows[0]?.id;
  if (insertedMessageId === undefined)
    return { conversationId, inserted: false };
  await sql`
    INSERT INTO messaging.message_delivery_events
      (tenant_id, message_id, provider_event_id, status, occurred_at)
    VALUES (platform.current_tenant_id(), ${insertedMessageId}::uuid,
            ${`sim_status_${input.providerEventId}`}, 'received', ${occurredAt})
    ON CONFLICT (tenant_id, provider_event_id) WHERE provider_event_id IS NOT NULL
    DO NOTHING
  `;
  await sql`
    UPDATE messaging.conversations
    SET unread_count = unread_count + 1,
        last_message_at = ${occurredAt},
        last_message_preview = ${input.text.trim()},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversationId}::uuid
  `;
  return { conversationId, inserted: true };
}

export async function ingestWhatsAppInbound(
  sql: postgres.TransactionSql,
  input: WhatsAppInboundEnvelope,
): Promise<{ readonly conversationId: string; readonly inserted: boolean }> {
  const phone = normalizeE164(input.from);
  if (phone === undefined)
    throw new TypeError("WhatsApp sender must use E.164");
  const text = input.text.trim();
  if (text === "") throw new TypeError("message text is required");
  const channelRows = await sql<{ id: string }[]>`
    SELECT id FROM messaging.channels
    WHERE provider = 'meta' AND provider_account_id = ${input.providerAccountId}
      AND status = 'active'
    LIMIT 1
  `;
  const channelId = channelRows[0]?.id;
  if (channelId === undefined)
    throw new Error("WhatsApp provider account is unavailable");

  const identityRows = await sql<{ contact_id: string }[]>`
    SELECT contact_id FROM crm.contact_channel_identities
    WHERE channel = 'whatsapp' AND normalized_value = ${phone}
    LIMIT 1
  `;
  let contactId = identityRows[0]?.contact_id;
  if (contactId === undefined) {
    const contactRows = await sql<{ id: string }[]>`
      INSERT INTO crm.contacts (tenant_id, name, last_activity_at)
      VALUES (platform.current_tenant_id(), ${input.profileName.trim() || phone},
              CURRENT_TIMESTAMP)
      RETURNING id
    `;
    contactId = contactRows[0]?.id;
    if (contactId === undefined)
      throw new Error("inbound contact insert failed");
    await sql`
      INSERT INTO crm.contact_channel_identities
        (tenant_id, contact_id, channel, normalized_value, display_value,
         provider, provider_identity_id, validation_status, is_primary)
      VALUES (platform.current_tenant_id(), ${contactId}::uuid, 'whatsapp',
              ${phone}, ${input.from}, 'meta', ${phone}, 'valid', true)
    `;
  } else {
    await sql`
      UPDATE crm.contacts SET name = ${input.profileName.trim() || phone},
             last_activity_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
      WHERE id = ${contactId}::uuid
    `;
  }

  await sql`
    UPDATE crm.contacts
    SET whatsapp_consent = CASE
          WHEN whatsapp_consent = 'unknown' AND whatsapp_opted_out_at IS NULL THEN 'granted'
          ELSE whatsapp_consent END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${contactId}::uuid
  `;

  const conversationRows = await sql<{ id: string }[]>`
    INSERT INTO messaging.conversations
      (tenant_id, channel_id, contact_id, status, unread_count,
       customer_service_window_expires_at)
    VALUES (platform.current_tenant_id(), ${channelId}::uuid, ${contactId}::uuid,
            'open', 0, CURRENT_TIMESTAMP + interval '24 hours')
    ON CONFLICT (tenant_id, channel_id, contact_id)
    DO UPDATE SET status = 'open', updated_at = CURRENT_TIMESTAMP,
                  customer_service_window_expires_at = CURRENT_TIMESTAMP + interval '24 hours'
    RETURNING id
  `;
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined)
    throw new Error("conversation resolution failed");
  const messageRows = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO messaging.messages
      (tenant_id, conversation_id, direction, sender_type, sender_contact_id,
       content_type, content_text, provider, provider_message_id, status,
       provider_payload)
    VALUES (platform.current_tenant_id(), ${conversationId}::uuid, 'inbound',
            'contact', ${contactId}::uuid, 'text', ${text}, 'meta',
            ${input.providerMessageId}, 'received',
            ${sql.json({ providerEventId: input.providerEventId })})
    ON CONFLICT (tenant_id, provider, provider_message_id)
      WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL
    DO NOTHING
    RETURNING id, created_at
  `;
  const message = messageRows[0];
  if (message === undefined) return { conversationId, inserted: false };
  await sql`
    INSERT INTO messaging.message_delivery_events
      (tenant_id, message_id, provider_event_id, status, occurred_at)
    VALUES (platform.current_tenant_id(), ${message.id}::uuid,
            ${input.providerEventId}, 'received', ${message.created_at})
    ON CONFLICT (tenant_id, provider_event_id) WHERE provider_event_id IS NOT NULL
    DO NOTHING
  `;
  await sql`
    UPDATE messaging.conversations
    SET unread_count = unread_count + 1, last_message_at = ${message.created_at},
        last_message_preview = ${text}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversationId}::uuid
  `;
  return { conversationId, inserted: true };
}

export async function ingestWhatsAppStatus(
  sql: postgres.TransactionSql,
  input: WhatsAppStatusEnvelope,
): Promise<boolean> {
  const messages = await sql<{ id: string }[]>`
    SELECT message.id
    FROM messaging.messages message
    JOIN messaging.conversations conversation ON conversation.id = message.conversation_id
      AND conversation.tenant_id = message.tenant_id
    JOIN messaging.channels channel ON channel.id = conversation.channel_id
      AND channel.tenant_id = conversation.tenant_id
    WHERE message.provider = 'meta' AND message.provider_message_id = ${input.providerMessageId}
      AND channel.provider_account_id = ${input.providerAccountId}
    LIMIT 1
  `;
  const messageId = messages[0]?.id;
  if (messageId === undefined)
    throw new TypeError("status references an unknown Meta message");
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO messaging.message_delivery_events
      (tenant_id, message_id, provider_event_id, status, occurred_at, payload)
    VALUES (platform.current_tenant_id(), ${messageId}::uuid, ${input.providerEventId},
            ${input.status}, ${input.occurredAt},
            ${sql.json(input.errorCode === undefined ? {} : { errorCode: input.errorCode })})
    ON CONFLICT (tenant_id, provider_event_id) WHERE provider_event_id IS NOT NULL
    DO NOTHING RETURNING id
  `;
  if (inserted.length === 0) return false;
  await sql`
    UPDATE messaging.messages SET status = CASE
      WHEN ${input.status} = 'failed' THEN 'failed'
      WHEN status = 'read' THEN status
      WHEN ${input.status} = 'read' THEN 'read'
      WHEN status = 'delivered' THEN status
      WHEN ${input.status} = 'delivered' THEN 'delivered'
      ELSE 'sent' END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${messageId}::uuid
  `;
  await sql`
    UPDATE messaging.outbound_requests SET status = CASE
      WHEN ${input.status} = 'failed' THEN 'failed'
      WHEN status = 'read' THEN status
      WHEN ${input.status} = 'read' THEN 'read'
      WHEN status = 'delivered' THEN status
      WHEN ${input.status} = 'delivered' THEN 'delivered'
      ELSE 'sent' END,
      last_error_code = ${input.errorCode ?? null},
      completed_at = CASE WHEN ${input.status} IN ('read', 'failed') THEN CURRENT_TIMESTAMP ELSE completed_at END,
      updated_at = CURRENT_TIMESTAMP
    WHERE message_id = ${messageId}::uuid
  `;
  return true;
}

/** A local simulator effect only: never resolves or invokes a real provider. */
export async function deliverSimulatedCallFollowup(
  sql: postgres.TransactionSql,
  jobId: string,
  contactId: string | null,
  payload: unknown,
): Promise<void> {
  if (payload === null || typeof payload !== "object")
    throw new TypeError("invalid simulated follow-up payload");
  const value = payload as Readonly<Record<string, unknown>>;
  if (
    value.mode !== "simulator" ||
    value.template !== "call-followup" ||
    contactId === null ||
    value.contactId !== contactId ||
    typeof value.sessionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.sessionId,
    ) ||
    typeof value.outcome !== "string" ||
    value.outcome.length === 0 ||
    value.outcome.length > 128
  )
    throw new TypeError("invalid simulated follow-up payload");

  // Serialize with consent changes and recheck after time spent in the queue.
  const contacts = await sql<{ id: string }[]>`
    SELECT id FROM crm.contacts
    WHERE id = ${contactId}::uuid AND tenant_id = platform.current_tenant_id()
      AND whatsapp_consent = 'granted' AND whatsapp_opted_out_at IS NULL
    FOR SHARE
  `;
  if (contacts[0] === undefined)
    throw new TypeError("WhatsApp follow-up consent is required");
  const channelId = await simulatorChannelId(sql);
  const conversations = await sql<{ id: string }[]>`
    INSERT INTO messaging.conversations (tenant_id, channel_id, contact_id, status)
    VALUES (platform.current_tenant_id(), ${channelId}::uuid, ${contactId}::uuid, 'open')
    ON CONFLICT (tenant_id, channel_id, contact_id)
    DO UPDATE SET channel_id = EXCLUDED.channel_id
    RETURNING id
  `;
  const conversationId = conversations[0]?.id;
  if (conversationId === undefined)
    throw new Error("follow-up conversation unavailable");
  const providerMessageId = `sim_call_followup_${jobId}`;
  const text =
    "[Simulator] Thank you for speaking with us. This is your call follow-up.";
  const messages = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO messaging.messages
      (tenant_id, conversation_id, direction, sender_type, content_type,
       content_text, provider, provider_message_id, status, provider_payload)
    VALUES (platform.current_tenant_id(), ${conversationId}::uuid, 'outbound',
            'system', 'text', ${text}, 'simulator', ${providerMessageId}, 'delivered',
            ${sql.json({ simulator: true, jobId, sessionId: value.sessionId })})
    ON CONFLICT (tenant_id, provider, provider_message_id)
      WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL
    DO NOTHING RETURNING id, created_at
  `;
  const message = messages[0];
  // A replay must not regress the conversation cursor or create another receipt.
  if (message === undefined) return;
  await sql`
    INSERT INTO messaging.message_delivery_events
      (tenant_id, message_id, provider_event_id, status, occurred_at)
    VALUES (platform.current_tenant_id(), ${message.id}::uuid,
            ${`sim_status_${providerMessageId}`}, 'delivered', ${message.created_at})
  `;
  await sql`
    UPDATE messaging.conversations
    SET last_message_at = ${message.created_at}, last_message_preview = ${text},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversationId}::uuid
      AND (last_message_at IS NULL OR last_message_at <= ${message.created_at})
  `;
}

export async function sendSimulatedReply(
  sql: postgres.TransactionSql,
  input: SimulatedOutboundInput,
): Promise<Message> {
  const text = input.text.trim();
  if (text === "") throw new TypeError("reply text is required");
  const digest = createHash("sha256")
    .update(`simulator:${input.idempotencyKey}`)
    .digest("hex");
  const providerMessageId = `sim_${digest.slice(0, 24)}`;
  const messageRows = await sql<MessageRow[]>`
    INSERT INTO messaging.messages
      (tenant_id, conversation_id, direction, sender_type, sender_user_id,
       content_type, content_text, provider, provider_message_id, status,
       provider_payload)
    VALUES (platform.current_tenant_id(), ${input.conversationId}::uuid,
            'outbound', 'user', ${input.senderUserId}::uuid, 'text', ${text},
            'simulator', ${providerMessageId}, 'delivered',
            ${sql.json({ simulator: true, deliveryId: randomUUID() })})
    ON CONFLICT (tenant_id, provider, provider_message_id)
      WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL
    DO UPDATE SET provider_message_id = EXCLUDED.provider_message_id
    RETURNING id, conversation_id, direction, sender_type, content_type,
              content_text, status, provider_message_id, created_at,
              '[]'::jsonb AS reactions, '[]'::jsonb AS delivery_events
  `;
  const row = messageRows[0];
  if (row === undefined) throw new Error("simulated reply insert failed");
  await sql`
    INSERT INTO messaging.message_delivery_events
      (tenant_id, message_id, provider_event_id, status, occurred_at)
    VALUES (platform.current_tenant_id(), ${row.id}::uuid,
            ${`sim_status_${providerMessageId}`}, 'delivered', ${row.created_at})
    ON CONFLICT (tenant_id, provider_event_id) WHERE provider_event_id IS NOT NULL
    DO NOTHING
  `;
  await sql`
    UPDATE messaging.conversations
    SET unread_count = 0, last_message_at = ${row.created_at},
        last_message_preview = ${text}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${input.conversationId}::uuid
  `;
  const refreshed = (await listMessages(sql, input.conversationId)).find(
    (message) => message.id === row.id,
  );
  if (refreshed === undefined)
    throw new Error("simulated reply could not be read");
  return refreshed;
}

export async function setConversationStatus(
  sql: postgres.TransactionSql,
  conversationId: string,
  status: ConversationSummary["status"],
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE messaging.conversations SET status = ${status},
      updated_at = CURRENT_TIMESTAMP WHERE id = ${conversationId}::uuid RETURNING id
  `;
  return rows.length === 1;
}

export async function assignConversation(
  sql: postgres.TransactionSql,
  conversationId: string,
  userId: string | null,
): Promise<boolean> {
  if (userId !== null) {
    const memberships = await sql<{ present: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM memberships
        WHERE tenant_id = platform.current_tenant_id() AND user_id = ${userId}::uuid
      ) AS present
    `;
    if (memberships[0]?.present !== true)
      throw new TypeError("assignee must be a current tenant member");
  }
  const rows = await sql<{ id: string }[]>`
    UPDATE messaging.conversations SET assigned_user_id = ${userId}::uuid,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversationId}::uuid RETURNING id
  `;
  return rows.length === 1;
}

export async function listQuickReplies(
  sql: postgres.TransactionSql,
): Promise<readonly QuickReply[]> {
  return sql<QuickReply[]>`
    SELECT id, title, body, shortcut FROM messaging.quick_replies
    ORDER BY lower(title), id
  `;
}

export async function addMessageReaction(
  sql: postgres.TransactionSql,
  messageId: string,
  actorUserId: string,
  emoji: string,
): Promise<void> {
  const normalized = emoji.trim();
  if (!normalized || normalized.length > 16)
    throw new TypeError("reaction must be a short emoji");
  await sql`
    INSERT INTO messaging.message_reactions
      (tenant_id, message_id, actor_type, actor_id, emoji)
    VALUES (platform.current_tenant_id(), ${messageId}::uuid, 'user', ${actorUserId}::uuid, ${normalized})
    ON CONFLICT (tenant_id, message_id, actor_type, actor_id)
    DO UPDATE SET emoji = EXCLUDED.emoji
  `;
}

export async function markConversationRead(
  sql: postgres.TransactionSql,
  conversationId: string,
): Promise<void> {
  await sql`
    UPDATE messaging.conversations SET unread_count = 0,
      updated_at = CURRENT_TIMESTAMP WHERE id = ${conversationId}::uuid
  `;
}
