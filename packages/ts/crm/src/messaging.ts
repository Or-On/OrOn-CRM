import { createHash, randomUUID } from "node:crypto";

import type postgres from "postgres";

import { normalizeE164 } from "./phone.js";
import { messageDeliveryFailure } from "./whatsapp-diagnostics.js";
import type {
  ConversationSummary,
  ConversationCursor,
  ConversationFilter,
  ConversationPage,
  Message,
  MessageLocation,
  MessageMedia,
  SimulatedInboundInput,
  SimulatedOutboundInput,
  QuickReply,
  MessageCursor,
  MessagePage,
  TemplateSummary,
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
  ownership_mode: "ai" | "human";
  ai_agent_profile_version_id: string | null;
  ai_enabled_at: Date | null;
  handoff_reason_safe: string | null;
  channel_kind: string;
  provider: string;
  sender_address: string | null;
  provider_account_id: string | null;
  recipient_address: string | null;
  whatsapp_consent: string;
  whatsapp_opted_out_at: Date | null;
  customer_service_window_expires_at: Date | null;
  cursor_last_message_at: string | null;
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
  structured_content: unknown;
  media_object_content_type: string | null;
  cursor_created_at: string;
  outbound_error_code: unknown;
  outbound_diagnostic: unknown;
}

export interface MessageMediaObjectMetadata {
  readonly id: string;
  readonly messageId: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly checksum: string;
  readonly storageBackend: "local" | "gcs";
  readonly storageKey: string;
  readonly status: "pending" | "available" | "quarantined" | "deleted";
  readonly fileName: string | null;
}

/** Project only the submitted template fields, never arbitrary provider payloads. */
export function templateSummary(value: unknown): TemplateSummary | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.templateName !== "string" ||
    typeof record.language !== "string" ||
    !Array.isArray(record.parameters) ||
    !record.parameters.every(
      (parameter: unknown) => typeof parameter === "string",
    )
  )
    return null;
  return {
    name: record.templateName,
    language: record.language,
    parameters: record.parameters,
  };
}

export function parseMessageCursor(
  createdAt: string | null,
  id: string | null,
): MessageCursor | undefined {
  if (createdAt === null && id === null) return undefined;
  if (
    createdAt === null ||
    id === null ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/u.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(id)
  )
    throw new TypeError("Invalid message history cursor");
  return { createdAt, id };
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

function structuredRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function boundedStructuredText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

/** Project only presentation-safe media fields, never provider ids or hashes. */
export function messageMedia(
  contentType: string,
  structured: unknown,
  mediaObjectContentType: string | null = null,
): MessageMedia | null {
  if (contentType !== "image" && contentType !== "document") return null;
  const record = structuredRecord(structured);
  const storedStatus = record.retrievalStatus;
  const status: MessageMedia["status"] =
    mediaObjectContentType !== null
      ? "available"
      : storedStatus === "pending" ||
          storedStatus === "processing" ||
          storedStatus === "failed"
        ? storedStatus
        : "unavailable";
  return {
    kind: contentType,
    status,
    mimeType:
      mediaObjectContentType ?? boundedStructuredText(record.mimeType, 255),
    fileName: boundedStructuredText(record.fileName, 255),
    caption: boundedStructuredText(record.caption, 4_096),
  };
}

/** Project validated coordinates and human labels without retaining raw payloads. */
export function messageLocation(
  contentType: string,
  structured: unknown,
): MessageLocation | null {
  if (contentType !== "location") return null;
  const record = structuredRecord(structured);
  const latitude = record.latitude;
  const longitude = record.longitude;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  )
    return null;
  return {
    latitude,
    longitude,
    name: boundedStructuredText(record.name, 1_000),
    address: boundedStructuredText(record.address, 1_000),
  };
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
    ownershipMode: row.ownership_mode,
    aiAgentProfileVersionId: row.ai_agent_profile_version_id,
    aiEnabledAt: row.ai_enabled_at?.toISOString() ?? null,
    handoffReasonSafe: row.handoff_reason_safe,
    channelKind: row.channel_kind,
    provider: row.provider,
    senderAddress: row.sender_address,
    providerAccountId: row.provider_account_id,
    recipientAddress: row.recipient_address,
    whatsAppConsent: row.whatsapp_consent,
    whatsAppOptedOutAt: row.whatsapp_opted_out_at?.toISOString() ?? null,
    customerServiceWindowExpiresAt:
      row.customer_service_window_expires_at?.toISOString() ?? null,
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
    deliveryFailure:
      row.status === "failed" || row.status === "queued"
        ? messageDeliveryFailure(
            row.outbound_error_code,
            row.outbound_diagnostic,
          )
        : null,
    template: templateSummary(row.structured_content),
    media: messageMedia(
      row.content_type,
      row.structured_content,
      row.media_object_content_type,
    ),
    location: messageLocation(row.content_type, row.structured_content),
    historyCursor: { id: row.id, createdAt: row.cursor_created_at },
  };
}

export function parseConversationCursor(
  lastMessageAt: string | null,
  id: string | null,
): ConversationCursor | undefined {
  if (lastMessageAt === null && id === null) return undefined;
  if (
    id === null ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(id) ||
    (lastMessageAt !== null &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/u.test(
        lastMessageAt,
      ) ||
        !Number.isFinite(Date.parse(lastMessageAt))))
  )
    throw new TypeError("Invalid conversation cursor");
  return { lastMessageAt, id };
}

export async function listConversationPage(
  sql: postgres.TransactionSql,
  options: {
    readonly conversationId?: string;
    readonly query?: string;
    readonly filter?: ConversationFilter;
    readonly currentUserId?: string;
    readonly channelKind?: "whatsapp";
    readonly before?: ConversationCursor;
    readonly limit?: number;
  } = {},
): Promise<ConversationPage> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new TypeError("Conversation page size must be 1–100");
  const query = options.query?.trim() ?? "";
  if (query.length > 120)
    throw new TypeError("Conversation search is too long");
  const filter = options.filter ?? "all";
  if (
    ![
      "all",
      "mine",
      "unassigned",
      "unread",
      "open",
      "waiting",
      "closed",
    ].includes(filter)
  )
    throw new TypeError("Invalid conversation filter");
  if (filter === "mine" && options.currentUserId === undefined)
    throw new TypeError("Current user is required for the Mine filter");
  const before =
    options.before === undefined
      ? undefined
      : parseConversationCursor(
          options.before.lastMessageAt,
          options.before.id,
        );
  // Bind the cursor timestamp as text before PostgreSQL casts it. Inferring a
  // timestamptz parameter makes the driver round-trip through JavaScript Date
  // and silently drops the microseconds required by the keyset cursor.
  const rows = await sql.unsafe<ConversationRow[]>(
    `SELECT c.id, c.contact_id, contact.name AS contact_name, c.status,
            c.unread_count, c.last_message_at, c.last_message_preview,
            c.assigned_user_id, c.ownership_mode,
            c.ai_agent_profile_version_id, c.ai_enabled_at,
            c.handoff_reason_safe, channel.kind AS channel_kind, channel.provider,
            channel.display_address AS sender_address, channel.provider_account_id,
            recipient.normalized_value AS recipient_address,
            contact.whatsapp_consent, contact.whatsapp_opted_out_at,
            c.customer_service_window_expires_at,
            CASE WHEN c.last_message_at IS NULL THEN NULL ELSE
              to_char(c.last_message_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            END AS cursor_last_message_at
       FROM messaging.conversations c
       JOIN crm.contacts contact
         ON contact.id = c.contact_id AND contact.tenant_id = c.tenant_id
       JOIN messaging.channels channel
         ON channel.id = c.channel_id AND channel.tenant_id = c.tenant_id
       LEFT JOIN LATERAL (
         SELECT identity.normalized_value
           FROM crm.contact_channel_identities identity
          WHERE identity.contact_id = c.contact_id
            AND identity.tenant_id = c.tenant_id
            AND identity.channel = 'whatsapp'
            AND identity.validation_status = 'valid'
            AND identity.normalized_value IS NOT NULL
          ORDER BY identity.is_primary DESC, identity.created_at, identity.id
          LIMIT 1
       ) recipient ON true
      WHERE c.tenant_id = platform.current_tenant_id()
        AND c.removed_from_inbox_at IS NULL
        AND ($1::uuid IS NULL OR c.id = $1::uuid)
        AND ($2 = '' OR position(lower($2) in lower(concat_ws(' ',
          contact.name, recipient.normalized_value, channel.display_address,
          channel.provider, c.last_message_preview))) > 0)
        AND ($3 = 'all'
          OR ($3 = 'mine' AND c.assigned_user_id = $4::uuid)
          OR ($3 = 'unassigned' AND c.assigned_user_id IS NULL)
          OR ($3 = 'unread' AND c.unread_count > 0)
          OR ($3 = 'open' AND c.status = 'open')
          OR ($3 = 'waiting' AND c.status = 'pending')
          OR ($3 = 'closed' AND c.status IN ('closed', 'resolved')))
        AND ($5::text IS NULL OR channel.kind = $5)
        AND ($7::uuid IS NULL OR
          ($6::text::timestamptz IS NULL AND c.last_message_at IS NULL AND c.id < $7::uuid)
          OR ($6::text::timestamptz IS NOT NULL AND (
            c.last_message_at < $6::text::timestamptz
            OR (c.last_message_at = $6::text::timestamptz AND c.id < $7::uuid)
            OR c.last_message_at IS NULL)))
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
      LIMIT $8`,
    [
      options.conversationId ?? null,
      query,
      filter,
      options.currentUserId ?? null,
      options.channelKind ?? null,
      before?.lastMessageAt ?? null,
      before?.id ?? null,
      limit + 1,
    ],
  );
  const hasMore = rows.length > limit;
  const selected = hasMore ? rows.slice(0, limit) : rows;
  const last = selected.at(-1);
  return {
    conversations: selected.map(mapConversation),
    nextCursor:
      hasMore && last !== undefined
        ? {
            lastMessageAt: last.cursor_last_message_at,
            id: last.id,
          }
        : null,
  };
}

export async function listConversations(
  sql: postgres.TransactionSql,
  conversationId?: string,
): Promise<readonly ConversationSummary[]> {
  return (
    await listConversationPage(sql, {
      ...(conversationId === undefined ? {} : { conversationId }),
      limit: 100,
    })
  ).conversations;
}

export async function listMessages(
  sql: postgres.TransactionSql,
  conversationId: string,
  options: { readonly includeRemoved?: boolean } = {},
): Promise<readonly Message[]> {
  return (
    await listMessagePage(sql, conversationId, {
      limit: 250,
      includeRemoved: options.includeRemoved === true,
    })
  ).messages;
}

export async function listMessagePage(
  sql: postgres.TransactionSql,
  conversationId: string,
  options: {
    readonly before?: MessageCursor;
    readonly includeMedia?: boolean;
    /** Retention/evidence readers only. Inbox callers must use the default. */
    readonly includeRemoved?: boolean;
    readonly limit?: number;
  } = {},
): Promise<MessagePage> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 250)
    throw new TypeError("Message page size must be 1–250");
  const before = parseMessageCursor(
    options.before?.createdAt ?? null,
    options.before?.id ?? null,
  );
  // Bind the timestamp as text, then cast in PostgreSQL. Driver timestamptz
  // serialization via JavaScript Date would discard microsecond cursor precision.
  const rows = await sql<MessageRow[]>`
    SELECT message.id, message.conversation_id, message.direction,
           message.sender_type, message.content_type, message.content_text,
           message.status, message.provider_message_id, message.created_at, message.structured_content,
           NULL::text AS media_object_content_type,
           outbound.last_error_code AS outbound_error_code,
           message.provider_payload -> 'whatsappSendDiagnostic' AS outbound_diagnostic,
           to_char(message.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
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
    JOIN messaging.conversations conversation
      ON conversation.id = message.conversation_id
     AND conversation.tenant_id = message.tenant_id
    LEFT JOIN messaging.outbound_requests outbound
      ON outbound.message_id = message.id AND outbound.tenant_id = message.tenant_id
    WHERE message.conversation_id = ${conversationId}::uuid
      AND (${options.includeRemoved === true}
           OR conversation.removed_from_inbox_at IS NULL)
      AND (${before?.createdAt ?? null}::text::timestamptz IS NULL OR
           (message.created_at, message.id) < (${before?.createdAt ?? null}::text::timestamptz, ${before?.id ?? null}::uuid))
    ORDER BY message.created_at DESC, message.id DESC
    LIMIT ${limit + 1}
  `;
  const availableMedia =
    options.includeMedia === true && rows.length > 0
      ? await sql<{ message_id: string; content_type: string }[]>`
          SELECT media.message_id, media.content_type
          FROM unnest(${rows.map((row) => row.id)}::uuid[]) requested(message_id)
          CROSS JOIN LATERAL
            messaging.current_tenant_message_media(requested.message_id) media
        `
      : [];
  const mediaByMessage = new Map(
    availableMedia.map((media) => [media.message_id, media.content_type]),
  );
  const messages = rows
    .slice(0, limit)
    .reverse()
    .map((row) =>
      mapMessage({
        ...row,
        media_object_content_type: mediaByMessage.get(row.id) ?? null,
      }),
    );
  return {
    messages,
    nextCursor:
      rows.length > limit ? (messages[0]?.historyCursor ?? null) : null,
  };
}

/**
 * Resolve a private object only through its tenant-visible inbound message.
 * The database function intentionally bridges the Inbox authorization model
 * without weakening Field Service's narrower technician object policy.
 */
export async function getMessageMediaObjectMetadata(
  sql: postgres.TransactionSql,
  messageId: string,
): Promise<MessageMediaObjectMetadata | undefined> {
  const rows = await sql<
    {
      id: string;
      message_id: string;
      content_type: string;
      byte_size: string;
      checksum: string;
      storage_backend: "local" | "gcs";
      storage_key: string;
      status: MessageMediaObjectMetadata["status"];
      file_name: string | null;
    }[]
  >`
    SELECT media.id, media.message_id, media.content_type, media.byte_size,
           media.checksum, media.storage_backend, media.storage_key,
           media.status, media.file_name
    FROM messaging.current_tenant_message_media(${messageId}::uuid) media
    JOIN messaging.messages message
      ON message.id = media.message_id
     AND message.tenant_id = platform.current_tenant_id()
    JOIN messaging.conversations conversation
      ON conversation.id = message.conversation_id
     AND conversation.tenant_id = message.tenant_id
    WHERE conversation.removed_from_inbox_at IS NULL
  `;
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        messageId: row.message_id,
        contentType: row.content_type,
        byteSize: Number(row.byte_size),
        checksum: row.checksum,
        storageBackend: row.storage_backend,
        storageKey: row.storage_key,
        status: row.status,
        fileName: row.file_name,
      };
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
        -- Reopened from Inbox removal: start with a new conversation's
        -- handling state. Removal ended the thread and cancelled its
        -- handoffs; a stale operator or handoff reason would block the default
        -- WhatsApp AI assignment that runs next. CASE reads the pre-update
        -- row, so a message to a live conversation keeps both unchanged.
        assigned_user_id = CASE
          WHEN removed_from_inbox_at IS NULL THEN assigned_user_id
        END,
        handoff_reason_safe = CASE
          WHEN removed_from_inbox_at IS NULL THEN handoff_reason_safe
        END,
        inbox_reopened_at = CASE
          WHEN removed_from_inbox_at IS NULL THEN inbox_reopened_at
          ELSE CURRENT_TIMESTAMP
        END,
        removed_from_inbox_at = NULL,
        removed_from_inbox_by_user_id = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversationId}::uuid
  `;
  return { conversationId, inserted: true };
}

export async function ingestWhatsAppInbound(
  sql: postgres.TransactionSql,
  input: WhatsAppInboundEnvelope,
): Promise<{
  readonly conversationId: string;
  readonly contactId: string;
  readonly messageId?: string;
  readonly inserted: boolean;
}> {
  const phone = normalizeE164(input.from);
  if (phone === undefined)
    throw new TypeError("WhatsApp sender must use E.164");
  const contentType = input.contentType ?? "text";
  const text = input.text.trim();
  if (contentType === "text" && text === "")
    throw new TypeError("message text is required");
  if (
    (contentType === "image" || contentType === "document") &&
    input.media === undefined
  )
    throw new TypeError("message media is required");
  if (contentType === "location" && input.location === undefined)
    throw new TypeError("message location is required");
  const occurredAt =
    input.occurredAt === undefined ? null : new Date(input.occurredAt);
  if (
    occurredAt !== null &&
    (!Number.isFinite(occurredAt.getTime()) ||
      occurredAt.getTime() > Date.now() + 300_000)
  )
    throw new TypeError("invalid inbound provider timestamp");
  const channelRows = await sql<
    { id: string; mirror_inbound_media: boolean }[]
  >`
    SELECT id, mirror_inbound_media FROM messaging.channels
    WHERE provider = 'meta' AND provider_account_id = ${input.providerAccountId}
      AND status = 'active'
    LIMIT 1
  `;
  const channel = channelRows[0];
  const channelId = channel?.id;
  if (channelId === undefined || channel === undefined)
    throw new Error("WhatsApp provider account is unavailable");

  const identityRows = await sql<{ id: string; contact_id: string }[]>`
    SELECT id, contact_id FROM crm.contact_channel_identities
    WHERE channel = 'whatsapp' AND normalized_value = ${phone}
    LIMIT 1
  `;
  let contactId = identityRows[0]?.contact_id;
  let senderIdentityId = identityRows[0]?.id;
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
    const insertedIdentities = await sql<{ id: string }[]>`
      INSERT INTO crm.contact_channel_identities
        (tenant_id, contact_id, channel, normalized_value, display_value,
         provider, provider_identity_id, validation_status, is_primary)
      VALUES (platform.current_tenant_id(), ${contactId}::uuid, 'whatsapp',
              ${phone}, ${input.from}, 'meta', ${phone}, 'valid', true)
      RETURNING id
    `;
    senderIdentityId = insertedIdentities[0]?.id;
  } else {
    await sql`
      UPDATE crm.contacts SET name = ${input.profileName.trim() || phone},
             last_activity_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
      WHERE id = ${contactId}::uuid
    `;
  }
  if (senderIdentityId === undefined)
    throw new Error("inbound WhatsApp identity resolution failed");

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
            'open', 0, CASE WHEN ${occurredAt}::timestamptz IS NULL THEN NULL ELSE LEAST(${occurredAt}::timestamptz, CURRENT_TIMESTAMP) + interval '24 hours' END)
    ON CONFLICT (tenant_id, channel_id, contact_id)
    DO UPDATE SET status = 'open', updated_at = CURRENT_TIMESTAMP,
                  customer_service_window_expires_at = GREATEST(messaging.conversations.customer_service_window_expires_at,
                    CASE WHEN ${occurredAt}::timestamptz IS NULL THEN NULL ELSE LEAST(${occurredAt}::timestamptz, CURRENT_TIMESTAMP) + interval '24 hours' END)
    RETURNING id
  `;
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined)
    throw new Error("conversation resolution failed");
  const structuredContent =
    contentType === "image" || contentType === "document"
      ? {
          providerMediaId: input.media?.id,
          mimeType: input.media?.mimeType,
          sha256: input.media?.sha256,
          fileName: input.media?.fileName,
          caption: input.media?.caption,
          retrievalStatus: channel.mirror_inbound_media
            ? "pending"
            : "unavailable",
        }
      : contentType === "location"
        ? {
            latitude: input.location?.latitude,
            longitude: input.location?.longitude,
            name: input.location?.name,
            address: input.location?.address,
          }
        : null;
  const preview =
    text ||
    (contentType === "image"
      ? "[Image]"
      : contentType === "document"
        ? "[Document]"
        : "[Location]");
  const messageRows = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO messaging.messages
      (tenant_id, conversation_id, direction, sender_type, sender_contact_id,
       content_type, content_text, provider, provider_message_id, status,
       structured_content, provider_payload, created_at)
    VALUES (platform.current_tenant_id(), ${conversationId}::uuid, 'inbound',
            'contact', ${contactId}::uuid, ${contentType},
            ${text === "" ? null : text}, 'meta',
            ${input.providerMessageId}, 'received',
            ${structuredContent === null ? null : sql.json(structuredContent)},
            ${sql.json({ providerEventId: input.providerEventId })},
            COALESCE(${occurredAt}, CURRENT_TIMESTAMP))
    ON CONFLICT (tenant_id, provider, provider_message_id)
      WHERE provider IS NOT NULL AND provider_message_id IS NOT NULL
    DO NOTHING
    RETURNING id, created_at
  `;
  const message = messageRows[0];
  if (message === undefined)
    return { conversationId, contactId, inserted: false };
  await sql`
    INSERT INTO messaging.inbound_message_origins
      (tenant_id, message_id, contact_identity_id, sender_address)
    VALUES (platform.current_tenant_id(), ${message.id}::uuid,
            ${senderIdentityId}::uuid, ${phone})
  `;
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
    SET unread_count = unread_count + 1,
        last_message_preview = CASE
          WHEN last_message_at IS NULL OR ${message.created_at} >= last_message_at
            THEN ${preview}
          ELSE last_message_preview END,
        last_message_at = GREATEST(last_message_at, ${message.created_at}),
        -- Reopened from Inbox removal: start with a new conversation's
        -- handling state. Removal ended the thread and cancelled its
        -- handoffs; a stale operator or handoff reason would block the default
        -- WhatsApp AI assignment that runs next. CASE reads the pre-update
        -- row, so a message to a live conversation keeps both unchanged.
        assigned_user_id = CASE
          WHEN removed_from_inbox_at IS NULL THEN assigned_user_id
        END,
        handoff_reason_safe = CASE
          WHEN removed_from_inbox_at IS NULL THEN handoff_reason_safe
        END,
        inbox_reopened_at = CASE
          WHEN removed_from_inbox_at IS NULL THEN inbox_reopened_at
          ELSE CURRENT_TIMESTAMP
        END,
        removed_from_inbox_at = NULL,
        removed_from_inbox_by_user_id = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversationId}::uuid
  `;
  return {
    conversationId,
    contactId,
    messageId: message.id,
    inserted: true,
  };
}

/**
 * Claims a never-handed-off conversation for the tenant's configured default
 * WhatsApp agent. Human ownership is sticky: once a person has taken over, an
 * inbound retry or later customer message cannot silently return control to AI.
 */
export async function assignDefaultWhatsAppAi(
  sql: postgres.TransactionSql,
  conversationId: string,
): Promise<boolean> {
  if (
    (
      await sql<{ enabled: boolean }[]>`
      SELECT platform.current_tenant_feature_enabled('whatsapp') AS enabled
    `
    )[0]?.enabled !== true
  )
    return false;
  const bindings = await sql<
    { agent_profile_version_id: string; updated_by_user_id: string }[]
  >`
    SELECT process.agent_profile_version_id,process.updated_by_user_id
    FROM automation.tenant_processes process
    JOIN agents.agent_profile_versions version
      ON version.id=process.agent_profile_version_id
     AND version.tenant_id=process.tenant_id
     AND version.published_at IS NOT NULL
     AND version.validation_status='valid'
     AND version.channel_capabilities @> ARRAY['whatsapp']::text[]
    WHERE process.enabled AND process.trigger_key='whatsapp.new_conversation'
      AND (process.channel='whatsapp' OR process.channel IS NULL)
      AND process.agent_profile_version_id IS NOT NULL
      AND process.updated_by_user_id IS NOT NULL
      AND platform.approved_agent_for_channel(version.id,'whatsapp')
      AND platform.messaging_ai_actor_authorized(process.updated_by_user_id)
    ORDER BY process.priority,process.id
    LIMIT 1
  `;
  const binding = bindings[0];
  if (binding !== undefined) {
    const assigned = await sql<{ id: string }[]>`
      UPDATE messaging.conversations SET ownership_mode='ai',
        ai_agent_profile_version_id=${binding.agent_profile_version_id}::uuid,
        ai_enabled_by_user_id=${binding.updated_by_user_id}::uuid,
        ai_enabled_at=CURRENT_TIMESTAMP,assigned_user_id=NULL,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=${conversationId}::uuid
        AND ownership_mode='human' AND assigned_user_id IS NULL
        AND handoff_reason_safe IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM automation.handoffs handoff
          WHERE handoff.conversation_id=${conversationId}::uuid
            AND handoff.status IN ('pending','accepted')
        )
      RETURNING id
    `;
    return assigned.length === 1;
  }
  const profiles = await sql<{ id: string }[]>`
    SELECT profile.id
    FROM crm.tenant_settings settings
    JOIN agents.agent_profiles profile
      ON profile.id=settings.whatsapp_ai_agent_profile_id
     AND profile.tenant_id=settings.tenant_id
    WHERE settings.tenant_id=platform.current_tenant_id()
      AND profile.archived_at IS NULL
  `;
  const profileId = profiles[0]?.id;
  if (profileId === undefined) return false;
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      platform.current_tenant_id()::text || ':agent-profile:' || ${profileId}, 11
    ))
  `;
  const rows = await sql<{ id: string }[]>`
    UPDATE messaging.conversations conversation
    SET ownership_mode='ai',
        ai_agent_profile_version_id=candidate.version_id,
        ai_enabled_by_user_id=settings.whatsapp_ai_enabled_by_user_id,
        ai_enabled_at=CURRENT_TIMESTAMP,
        assigned_user_id=NULL,
        updated_at=CURRENT_TIMESTAMP
    FROM crm.tenant_settings settings
    JOIN agents.agent_profiles profile
      ON profile.id=settings.whatsapp_ai_agent_profile_id
     AND profile.tenant_id=settings.tenant_id
     AND profile.archived_at IS NULL
    JOIN LATERAL (
      SELECT version.id AS version_id
      FROM agents.agent_profile_versions version
      WHERE version.agent_profile_id=profile.id
        AND version.tenant_id=profile.tenant_id
        AND version.published_at IS NOT NULL
        AND version.validation_status='valid'
        AND version.channel_capabilities @> ARRAY['whatsapp']::text[]
        AND platform.approved_agent_for_channel(version.id,'whatsapp')
      ORDER BY version.version DESC, version.id DESC
      LIMIT 1
    ) candidate ON true
    WHERE conversation.id=${conversationId}::uuid
      AND conversation.tenant_id=platform.current_tenant_id()
      AND settings.tenant_id=conversation.tenant_id
      AND profile.id=${profileId}::uuid
      AND conversation.ownership_mode='human'
      AND conversation.assigned_user_id IS NULL
      AND conversation.handoff_reason_safe IS NULL
      AND settings.whatsapp_ai_enabled_by_user_id IS NOT NULL
      AND platform.messaging_ai_actor_authorized(settings.whatsapp_ai_enabled_by_user_id)
      AND NOT EXISTS (
        SELECT 1 FROM automation.handoffs handoff
        WHERE handoff.conversation_id=conversation.id
          AND handoff.status IN ('pending','accepted')
      )
    RETURNING conversation.id
  `;
  return rows.length === 1;
}

export async function createInboundConversationNotifications(
  sql: postgres.TransactionSql,
  conversationId: string,
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO messaging.notifications
      (tenant_id, user_id, type, title, body, reference_type, reference_id)
    SELECT platform.current_tenant_id(), recipient.user_id,
           'whatsapp.inbound', 'New WhatsApp message',
           'A customer message is waiting in the Inbox.',
           'conversation', ${conversationId}::uuid
    FROM platform.current_tenant_notification_recipients() recipient
    RETURNING id
  `;
  return rows.length;
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
  const conversations = await sql<{ id: string }[]>`
    SELECT id FROM messaging.conversations
    WHERE id = ${input.conversationId}::uuid
      AND removed_from_inbox_at IS NULL
    FOR SHARE
  `;
  if (conversations[0] === undefined)
    throw new TypeError("conversation is unavailable");
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
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversationId}::uuid
      AND removed_from_inbox_at IS NULL
    RETURNING id
  `;
  return rows.length === 1;
}

export interface ConversationPrivateObjectCleanup {
  readonly id: string;
  readonly storageBackend: "local" | "gcs";
  readonly storageKey: string;
}

export type ConversationDeletionResult =
  | {
      readonly status: "deleted";
      readonly privateObjects: readonly ConversationPrivateObjectCleanup[];
    }
  | { readonly status: "not_found" }
  | { readonly status: "active_work" }
  | { readonly status: "removed_retained_evidence" };

/**
 * Remove one tenant-visible conversation from the Inbox. Ordinary conversations
 * are permanently deleted with their dependent messaging records; technician
 * case evidence is retained and hidden from the Inbox instead. Contacts and
 * audit history intentionally remain in both cases.
 *
 * The row lock serializes this operation with other conversation mutations.
 * Active delivery/AI work is never cancelled implicitly: an operator must wait
 * for it to reach a terminal state before deleting the thread. A pending human
 * handoff is different: explicitly removing the conversation cancels that
 * internal queue item atomically so it cannot leave the thread undeletable.
 * A conversation that became part of a durable business record is retained
 * because its original messages and media are evidence, not disposable Inbox
 * state. This includes technician cases, support tickets, leads, and verified
 * voice handoffs. The retention check mirrors every restricted conversation or
 * message foreign key so a valid removal cannot become a generic database error.
 * Unshared message-owned objects are tombstoned in the same transaction; the
 * caller may remove their physical files only after this transaction commits.
 */
export async function deleteConversation(
  sql: postgres.TransactionSql,
  conversationId: string,
  actorUserId: string,
): Promise<ConversationDeletionResult> {
  const conversations = await sql<
    { id: string; removed_from_inbox_at: Date | null }[]
  >`
    SELECT id, removed_from_inbox_at FROM messaging.conversations
    WHERE id = ${conversationId}::uuid
    FOR UPDATE
  `;
  const conversation = conversations[0];
  if (conversation === undefined) return { status: "not_found" };

  // Prevent a worker from attaching new durable case evidence between the
  // retention check and the cascading conversation delete. The object lock
  // also makes the attachment validator observe the committed tombstone if a
  // late projection was already waiting on this deletion.
  await sql`
    SELECT message.id FROM messaging.messages message
    WHERE message.conversation_id = ${conversationId}::uuid
    FOR UPDATE OF message
  `;
  await sql`
    SELECT object.id
    FROM messaging.messages message
    JOIN objects.object_metadata object
      ON object.id = message.object_id AND object.tenant_id = message.tenant_id
    WHERE message.conversation_id = ${conversationId}::uuid
    FOR UPDATE OF object
  `;

  const work = await sql<{ active: boolean }[]>`
    SELECT (
      EXISTS (
        SELECT 1
        FROM messaging.outbound_requests request
        WHERE request.conversation_id = ${conversationId}::uuid
          AND request.status IN ('queued', 'sending')
      ) OR EXISTS (
        SELECT 1
        FROM ops.jobs job
        WHERE job.tenant_id = platform.current_tenant_id()
          AND job.status IN ('queued', 'running', 'retry')
          AND (
            (job.reference_type = 'conversation'
              AND job.reference_id = ${conversationId}::uuid)
            OR (
              job.reference_type = 'outbound_request'
              AND EXISTS (
                SELECT 1 FROM messaging.outbound_requests request
                WHERE request.id = job.reference_id
                  AND request.conversation_id = ${conversationId}::uuid
              )
            )
            OR (
              job.reference_type = 'message'
              AND EXISTS (
                SELECT 1 FROM messaging.messages message
                WHERE message.id = job.reference_id
                  AND message.conversation_id = ${conversationId}::uuid
              )
            )
            OR EXISTS (
              SELECT 1 FROM messaging.messages callback_message
              WHERE callback_message.id = job.callback_trigger_message_id
                AND callback_message.tenant_id = job.tenant_id
                AND callback_message.conversation_id = ${conversationId}::uuid
            )
            OR job.payload ->> 'conversationId' = ${conversationId}::uuid::text
            OR (
              job.reference_type = 'flow_run'
              AND EXISTS (
                SELECT 1 FROM automation.flow_runs flow_run
                WHERE flow_run.id = job.reference_id
                  AND flow_run.tenant_id = job.tenant_id
                  AND flow_run.trigger_metadata ->> 'conversationId' =
                    ${conversationId}::uuid::text
              )
            )
          )
      )
    ) AS active
  `;
  if (work[0]?.active === true) return { status: "active_work" };

  const cancelledHandoffs = await sql<{ id: string }[]>`
    UPDATE automation.handoffs
    SET status = 'cancelled',
        resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
    WHERE conversation_id = ${conversationId}::uuid
      AND status IN ('pending', 'accepted')
    RETURNING id
  `;
  if (cancelledHandoffs.length > 0)
    await sql`
      INSERT INTO audit.records
        (tenant_id, actor_user_id, action, target_type, target_id, metadata)
      SELECT platform.current_tenant_id(), ${actorUserId}::uuid,
             'handoff.cancelled_by_conversation_removal', 'handoff',
             handoff.id,
             ${sql.json({ conversationId })}
      FROM unnest(${cancelledHandoffs.map((handoff) => handoff.id)}::uuid[])
           AS handoff(id)
    `;

  const evidence = await sql<{ retained: boolean }[]>`
    SELECT (
      EXISTS (
        SELECT 1 FROM service.intake_drafts intake
        WHERE intake.conversation_id = ${conversationId}::uuid
      ) OR EXISTS (
        SELECT 1 FROM service.cases service_case
        WHERE service_case.conversation_id = ${conversationId}::uuid
      ) OR EXISTS (
        SELECT 1 FROM service.case_conversations link
        WHERE link.conversation_id = ${conversationId}::uuid
      ) OR EXISTS (
        SELECT 1
        FROM service.intake_messages intake_message
        JOIN messaging.messages message
          ON message.id = intake_message.message_id
         AND message.tenant_id = intake_message.tenant_id
        WHERE message.conversation_id = ${conversationId}::uuid
      ) OR EXISTS (
        SELECT 1
        FROM service.report_attachments attachment
        JOIN messaging.messages message
          ON message.tenant_id = attachment.tenant_id
         AND (
           message.id = attachment.message_id
           OR message.object_id = attachment.object_id
         )
        WHERE message.conversation_id = ${conversationId}::uuid
      ) OR EXISTS (
        SELECT 1
        FROM support.tickets ticket
        WHERE ticket.tenant_id = platform.current_tenant_id()
          AND ticket.source_conversation_id = ${conversationId}::uuid
      ) OR platform.conversation_has_voice_identity_verification(
        ${conversationId}::uuid
      ) OR EXISTS (
        SELECT 1
        FROM crm.leads lead
        WHERE lead.tenant_id = platform.current_tenant_id()
          AND lead.source_conversation_id = ${conversationId}::uuid
      ) OR EXISTS (
        SELECT 1
        FROM crm.lead_interactions interaction
        WHERE interaction.tenant_id = platform.current_tenant_id()
          AND interaction.conversation_id = ${conversationId}::uuid
      )
    ) AS retained
  `;
  if (evidence[0]?.retained === true) {
    const firstRemoval = conversation.removed_from_inbox_at === null;
    await sql`
      UPDATE messaging.conversations
      SET removed_from_inbox_at = COALESCE(removed_from_inbox_at, CURRENT_TIMESTAMP),
          removed_from_inbox_by_user_id = CASE
            WHEN removed_from_inbox_at IS NULL THEN ${actorUserId}::uuid
            ELSE removed_from_inbox_by_user_id
          END,
          unread_count = 0,
          ownership_mode = CASE
            WHEN ownership_mode = 'ai' THEN 'human'
            ELSE ownership_mode
          END,
          ai_agent_profile_version_id = CASE
            WHEN ownership_mode = 'ai' THEN NULL
            ELSE ai_agent_profile_version_id
          END,
          ai_enabled_by_user_id = CASE
            WHEN ownership_mode = 'ai' THEN NULL
            ELSE ai_enabled_by_user_id
          END,
          ai_enabled_at = CASE
            WHEN ownership_mode = 'ai' THEN NULL
            ELSE ai_enabled_at
          END,
          -- Its handoffs were cancelled above; keeping the operator or the
          -- handoff reason would pin the next customer message to a person.
          assigned_user_id = NULL,
          handoff_reason_safe = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${conversationId}::uuid
    `;
    await sql`
      DELETE FROM messaging.notifications
      WHERE tenant_id = platform.current_tenant_id()
        AND reference_type = 'conversation'
        AND reference_id = ${conversationId}::uuid
    `;
    if (firstRemoval)
      await sql`
        INSERT INTO audit.records
          (tenant_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES (platform.current_tenant_id(), ${actorUserId}::uuid,
                'conversation.removed_from_inbox', 'conversation',
                ${conversationId}::uuid,
                ${sql.json({
                  retainedTechnicianEvidence: true,
                  cancelledHandoffCount: cancelledHandoffs.length,
                })})
      `;
    return { status: "removed_retained_evidence" };
  }

  const privateObjects = await sql<
    {
      id: string;
      storage_backend: "local" | "gcs";
      storage_key: string;
    }[]
  >`
    UPDATE objects.object_metadata object
    SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE object.tenant_id = platform.current_tenant_id()
      AND object.owner_type = 'message'
      AND object.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM messaging.messages message
        WHERE message.conversation_id = ${conversationId}::uuid
          AND message.id = object.owner_id
          AND message.object_id = object.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM messaging.messages other_message
        WHERE other_message.object_id = object.id
          AND other_message.conversation_id <> ${conversationId}::uuid
      )
      AND NOT EXISTS (
        SELECT 1 FROM crm.customer_documents document
        WHERE document.object_id = object.id AND document.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM service.report_attachments attachment
        WHERE attachment.object_id = object.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM service.visits visit
        WHERE visit.arrival_signature_object_id = object.id
           OR visit.departure_signature_object_id = object.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM service.export_records export_record
        WHERE export_record.object_id = object.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM agents.knowledge_documents document
        WHERE document.object_id = object.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.sessions session
        WHERE session.recording_object_id = object.id
           OR session.transcript_object_id = object.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM live.voice_profiles profile
        WHERE profile.object_id = object.id
      )
    RETURNING object.id, object.storage_backend, object.storage_key
  `;

  const deleted = await sql<{ id: string }[]>`
    DELETE FROM messaging.conversations
    WHERE id = ${conversationId}::uuid
    RETURNING id
  `;
  if (deleted[0] === undefined) return { status: "not_found" };

  await sql`
    DELETE FROM messaging.notifications
    WHERE tenant_id = platform.current_tenant_id()
      AND reference_type = 'conversation'
      AND reference_id = ${conversationId}::uuid
  `;

  await sql`
    INSERT INTO audit.records
      (tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (platform.current_tenant_id(), ${actorUserId}::uuid,
            'conversation.deleted', 'conversation', ${conversationId}::uuid,
            ${sql.json({
              retainedContact: true,
              tombstonedPrivateObjectCount: privateObjects.length,
              cancelledHandoffCount: cancelledHandoffs.length,
            })})
  `;
  return {
    status: "deleted",
    privateObjects: privateObjects.map((object) => ({
      id: object.id,
      storageBackend: object.storage_backend,
      storageKey: object.storage_key,
    })),
  };
}

export async function assignConversation(
  sql: postgres.TransactionSql,
  conversationId: string,
  userId: string | null,
): Promise<boolean> {
  if (userId !== null) {
    const memberships = await sql<{ present: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM platform.current_tenant_team()
        WHERE user_id = ${userId}::uuid
      ) AS present
    `;
    if (memberships[0]?.present !== true)
      throw new TypeError("assignee must be a current tenant member");
  }
  const rows = await sql<{ id: string }[]>`
    UPDATE messaging.conversations SET assigned_user_id = ${userId}::uuid,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversationId}::uuid
      AND removed_from_inbox_at IS NULL
    RETURNING id
  `;
  return rows.length === 1;
}

export async function setConversationOwnership(
  sql: postgres.TransactionSql,
  conversationId: string,
  actorUserId: string,
  ownershipMode: "ai" | "human",
  agentProfileVersionId?: string,
  reason?: string,
): Promise<boolean> {
  if (ownershipMode === "ai") {
    if (agentProfileVersionId === undefined)
      throw new TypeError("a published WhatsApp agent is required");
    const candidates = await sql<{ agent_profile_id: string }[]>`
      SELECT agent_profile_id
      FROM agents.agent_profile_versions
      WHERE id=${agentProfileVersionId}::uuid
        AND tenant_id=platform.current_tenant_id()
    `;
    const profileId = candidates[0]?.agent_profile_id;
    if (profileId === undefined)
      throw new TypeError("a published WhatsApp agent is required");
    await sql`
      SELECT pg_advisory_xact_lock(hashtextextended(
        platform.current_tenant_id()::text || ':agent-profile:' || ${profileId}, 11
      ))
    `;
    const agents = await sql<{ id: string }[]>`
      SELECT version.id
      FROM agents.agent_profile_versions version
      JOIN agents.agent_profiles profile
        ON profile.id=version.agent_profile_id
       AND profile.tenant_id=version.tenant_id
      WHERE version.id = ${agentProfileVersionId}::uuid
        AND version.tenant_id = platform.current_tenant_id()
        AND version.published_at IS NOT NULL
        AND version.validation_status = 'valid'
        AND version.channel_capabilities @> ARRAY['whatsapp']::text[]
        AND profile.archived_at IS NULL
      LIMIT 1
    `;
    if (agents[0] === undefined)
      throw new TypeError("a published WhatsApp agent is required");
    const rows = await sql<{ id: string }[]>`
      UPDATE messaging.conversations
      SET ownership_mode = 'ai',
          ai_agent_profile_version_id = ${agentProfileVersionId}::uuid,
          ai_enabled_by_user_id = ${actorUserId}::uuid,
          ai_enabled_at = CURRENT_TIMESTAMP,
          assigned_user_id = NULL,
          handoff_reason_safe = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${conversationId}::uuid
        AND removed_from_inbox_at IS NULL
      RETURNING id
    `;
    return rows.length === 1;
  }

  const proposedReason = reason?.trim().slice(0, 500);
  const safeReason =
    proposedReason !== undefined && proposedReason.length > 0
      ? proposedReason
      : "Human takeover requested";
  const rows = await sql<{ id: string; contact_id: string }[]>`
    UPDATE messaging.conversations
    SET ownership_mode = 'human',
        ai_agent_profile_version_id = NULL,
        ai_enabled_by_user_id = NULL,
        ai_enabled_at = NULL,
        assigned_user_id = ${actorUserId}::uuid,
        handoff_reason_safe = ${safeReason},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversationId}::uuid
      AND removed_from_inbox_at IS NULL
    RETURNING id, contact_id
  `;
  const updated = rows[0];
  if (updated !== undefined) {
    await sql`
      INSERT INTO automation.handoffs
        (tenant_id, contact_id, conversation_id, requested_by_user_id,
         assigned_user_id, source_channel, reason_safe, status,
         idempotency_key, accepted_at)
      VALUES (platform.current_tenant_id(), ${updated.contact_id}::uuid,
              ${conversationId}::uuid, ${actorUserId}::uuid,
              ${actorUserId}::uuid, 'whatsapp', ${safeReason}, 'accepted',
              ${`human-takeover:${conversationId}:${randomUUID()}`}, CURRENT_TIMESTAMP)
    `;
    await sql`
      INSERT INTO audit.records
        (tenant_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (platform.current_tenant_id(), ${actorUserId}::uuid,
              'conversation.human_takeover', 'conversation',
              ${conversationId}::uuid, ${sql.json({ reason: safeReason })})
    `;
  }
  return updated !== undefined;
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
): Promise<boolean> {
  const normalized = emoji.trim();
  if (!normalized || normalized.length > 16)
    throw new TypeError("reaction must be a short emoji");
  const rows = await sql<{ id: string }[]>`
    WITH eligible_conversation AS MATERIALIZED (
      SELECT conversation.id
      FROM messaging.conversations conversation
      JOIN messaging.messages message
        ON message.conversation_id = conversation.id
       AND message.tenant_id = conversation.tenant_id
      WHERE message.id = ${messageId}::uuid
        AND conversation.removed_from_inbox_at IS NULL
      FOR UPDATE OF conversation
    )
    INSERT INTO messaging.message_reactions
      (tenant_id, message_id, actor_type, actor_id, emoji)
    SELECT platform.current_tenant_id(), message.id, 'user',
           ${actorUserId}::uuid, ${normalized}
    FROM eligible_conversation
    JOIN messaging.messages message
      ON message.conversation_id = eligible_conversation.id
     AND message.id = ${messageId}::uuid
    ON CONFLICT (tenant_id, message_id, actor_type, actor_id)
    DO UPDATE SET emoji = EXCLUDED.emoji
    RETURNING id
  `;
  return rows.length === 1;
}

export async function markConversationRead(
  sql: postgres.TransactionSql,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE messaging.conversations SET unread_count = 0,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversationId}::uuid
      AND removed_from_inbox_at IS NULL
    RETURNING id
  `;
  if (rows[0] === undefined) return false;
  await sql`
    UPDATE messaging.notifications
    SET read_at=COALESCE(read_at, CURRENT_TIMESTAMP)
    WHERE user_id=${userId}::uuid AND reference_type='conversation'
      AND reference_id=${conversationId}::uuid
  `;
  return true;
}
