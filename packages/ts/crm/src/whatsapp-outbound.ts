import { createHash } from "node:crypto";
import type postgres from "postgres";

import { normalizeE164 } from "./phone.js";

export type WhatsAppOutboundInput =
  | {
      readonly conversationId: string;
      readonly explicitlyConfirmed: boolean;
      readonly idempotencyKey: string;
      readonly kind: "text";
      readonly provider: "simulator" | "meta";
      readonly realProviderEnabled: boolean;
      readonly recipientAddress?: string;
      readonly recipientIdentityId?: string;
      readonly senderUserId: string;
      readonly senderType?: "user" | "agent" | "system";
      readonly text: string;
      /**
       * A phone intake's follow-up. The recipient must then be the intake's
       * pinned telephony caller number (or its WhatsApp twin), verified in
       * PostgreSQL, instead of the latest inbound WhatsApp origin.
       */
      readonly voiceFollowUpIntakeId?: string;
    }
  | {
      readonly conversationId: string;
      readonly explicitlyConfirmed: boolean;
      readonly idempotencyKey: string;
      readonly kind: "template";
      readonly language: string;
      readonly parameters: readonly string[];
      readonly provider: "simulator" | "meta";
      readonly realProviderEnabled: boolean;
      readonly recipientAddress?: string;
      readonly recipientIdentityId?: string;
      readonly senderUserId: string;
      readonly senderType?: "user" | "agent" | "system";
      readonly templateName: string;
      readonly voiceFollowUpIntakeId?: string;
    };

export interface WhatsAppChannelConfiguration {
  readonly graphApiVersion: string;
  readonly phoneNumberId: string;
  readonly wabaId: string;
}

export interface QueuedWhatsAppOutbound {
  readonly conversationId: string;
  readonly messageId: string;
  readonly provider: "simulator" | "meta";
  readonly queued: boolean;
  readonly requestId: string;
}

interface ConversationContact {
  channel_id: string;
  conversation_id: string;
  contact_id: string;
  customer_service_window_expires_at: Date | null;
  lifecycle_status: string;
  ownership_epoch: string;
  whatsapp_consent: string;
  whatsapp_opted_out_at: Date | null;
  recipient_identity_id: string;
  normalized_value: string;
}

function validateInput(input: WhatsAppOutboundInput): void {
  if (
    input.idempotencyKey.trim().length < 8 ||
    input.idempotencyKey.length > 200
  )
    throw new TypeError("idempotency key must contain 8-200 characters");
  if (input.provider === "meta" && !input.realProviderEnabled)
    throw new TypeError("real WhatsApp provider is disabled");
  if (input.provider === "meta" && !input.explicitlyConfirmed)
    throw new TypeError(
      "real WhatsApp delivery requires explicit confirmation",
    );
  if (
    input.recipientIdentityId !== undefined &&
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(
      input.recipientIdentityId,
    )
  )
    throw new TypeError("invalid WhatsApp recipient identity");
  if (
    (input.recipientIdentityId === undefined) !==
    (input.recipientAddress === undefined)
  )
    throw new TypeError(
      "WhatsApp recipient identity and address must be bound together",
    );
  if (
    input.recipientAddress !== undefined &&
    normalizeE164(input.recipientAddress) !== input.recipientAddress
  )
    throw new TypeError("invalid WhatsApp recipient address");
  if (
    input.voiceFollowUpIntakeId !== undefined &&
    (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(
      input.voiceFollowUpIntakeId,
    ) ||
      input.recipientIdentityId === undefined)
  )
    throw new TypeError(
      "a voice follow-up requires its intake and a verified recipient",
    );
  if (input.kind === "text") {
    const text = input.text.trim();
    if (text.length === 0 || text.length > 4096)
      throw new TypeError("text must contain 1-4096 characters");
  } else {
    if (!/^[a-z0-9_]{1,512}$/u.test(input.templateName))
      throw new TypeError("invalid template name");
    if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(input.language))
      throw new TypeError("invalid template language");
    if (
      input.parameters.length > 100 ||
      input.parameters.some((value) => value.length > 1024)
    )
      throw new TypeError("invalid template parameters");
  }
}

export async function queueWhatsAppOutbound(
  sql: postgres.TransactionSql,
  input: WhatsAppOutboundInput,
  channelConfiguration?: WhatsAppChannelConfiguration,
): Promise<QueuedWhatsAppOutbound> {
  validateInput(input);
  if (input.provider === "meta" && channelConfiguration === undefined)
    throw new TypeError("real WhatsApp channel is not configured");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        conversationId: input.conversationId,
        provider: input.provider,
        ...(input.recipientIdentityId === undefined
          ? {}
          : {
              recipientIdentityId: input.recipientIdentityId,
              recipientAddress: input.recipientAddress,
            }),
        senderUserId: input.senderUserId,
        senderType: input.senderType ?? "user",
        delivery:
          input.kind === "text"
            ? { kind: "text", text: input.text.trim() }
            : {
                kind: "template",
                name: input.templateName,
                language: input.language,
                parameters: input.parameters,
              },
      }),
    )
    .digest("hex");
  // Serialize outbound admission with Inbox removal. The availability predicate
  // is evaluated while acquiring the row lock, so a sender waiting behind a
  // removal observes the committed removed/deleted state instead of queuing a
  // message from a stale pre-removal read. Holding the lock through request/job
  // creation also makes a concurrent removal observe the newly queued work and
  // return active_work rather than hiding or deleting the conversation.
  const availableConversations = await sql<{ id: string }[]>`
    SELECT id
    FROM messaging.conversations
    WHERE id = ${input.conversationId}::uuid
      AND removed_from_inbox_at IS NULL
    FOR UPDATE
  `;
  if (availableConversations[0] === undefined)
    throw new TypeError("conversation is no longer available in the Inbox");
  // Keep the global lock order consistent with Inbox removal and every caller
  // that already owns the conversation row: conversation first, idempotency
  // key second. Reversing this order can deadlock an AI/flow transaction that
  // holds the row while a retry holds the advisory lock.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(platform.current_tenant_id()::text || ':' || ${input.idempotencyKey}, 0))`;
  const existing = await sql<
    {
      id: string;
      message_id: string;
      conversation_id: string;
      provider: "simulator" | "meta";
      request_fingerprint: string | null;
      removed_from_inbox_at: Date | null;
    }[]
  >`
    SELECT outbound.id, outbound.message_id, outbound.conversation_id,
           outbound.provider, outbound.request_fingerprint,
           conversation.removed_from_inbox_at
    FROM messaging.outbound_requests outbound
    JOIN messaging.conversations conversation
      ON conversation.id=outbound.conversation_id
     AND conversation.tenant_id=outbound.tenant_id
    WHERE outbound.tenant_id = platform.current_tenant_id()
      AND outbound.idempotency_key = ${input.idempotencyKey}
  `;
  if (existing[0] !== undefined) {
    if (existing[0].removed_from_inbox_at !== null)
      throw new TypeError("conversation is no longer available in the Inbox");
    if (existing[0].request_fingerprint !== fingerprint)
      throw new TypeError(
        "idempotency key belongs to a different outbound request",
      );
    return {
      requestId: existing[0].id,
      messageId: existing[0].message_id,
      conversationId: existing[0].conversation_id,
      provider: existing[0].provider,
      queued: false,
    };
  }

  const contacts =
    input.voiceFollowUpIntakeId !== undefined
      ? await sql<ConversationContact[]>`
          SELECT conversation.id AS conversation_id,
                 conversation.channel_id, conversation.contact_id,
                 conversation.customer_service_window_expires_at,
                 conversation.ownership_epoch, contact.lifecycle_status,
                 contact.whatsapp_consent, contact.whatsapp_opted_out_at,
                 identity.id AS recipient_identity_id,
                 identity.normalized_value
          FROM messaging.conversations conversation
          JOIN messaging.channels channel
            ON channel.id=conversation.channel_id
           AND channel.tenant_id=conversation.tenant_id
           AND channel.kind='whatsapp' AND channel.provider=${input.provider}
           AND channel.status='active'
          JOIN crm.contacts contact ON contact.id=conversation.contact_id
           AND contact.tenant_id=conversation.tenant_id
          JOIN crm.contact_channel_identities identity
            ON identity.id=${input.recipientIdentityId ?? null}::uuid
           AND identity.tenant_id=conversation.tenant_id
           AND identity.contact_id=contact.id
          WHERE conversation.id=${input.conversationId}::uuid
            AND conversation.removed_from_inbox_at IS NULL
            AND service.verified_followup_recipient(
              ${input.voiceFollowUpIntakeId}::uuid, conversation.id,
              identity.id, ${input.recipientAddress ?? null})
            AND (${input.provider} <> 'meta' OR (
              channel.provider_account_id=${channelConfiguration?.phoneNumberId ?? null}
              AND channel.configuration->>'phoneNumberId'=${channelConfiguration?.phoneNumberId ?? null}
              AND channel.configuration->>'wabaId'=${channelConfiguration?.wabaId ?? null}
              AND channel.configuration->>'graphApiVersion'=${channelConfiguration?.graphApiVersion ?? null}))
          LIMIT 1
        `
      : input.provider === "meta"
        ? await sql<ConversationContact[]>`
          SELECT conversation.id AS conversation_id,
                 conversation.channel_id, conversation.contact_id,
                 conversation.customer_service_window_expires_at,
                 conversation.ownership_epoch, contact.lifecycle_status,
                 contact.whatsapp_consent, contact.whatsapp_opted_out_at,
                 identity.id AS recipient_identity_id,
                 identity.normalized_value
          FROM messaging.conversations conversation
          JOIN messaging.channels channel
            ON channel.id=conversation.channel_id
           AND channel.tenant_id=conversation.tenant_id
           AND channel.kind='whatsapp' AND channel.provider='meta'
           AND channel.status='active'
          JOIN crm.contacts contact ON contact.id=conversation.contact_id
           AND contact.tenant_id=conversation.tenant_id
          JOIN LATERAL (
            SELECT inbound.id
            FROM messaging.messages inbound
            WHERE inbound.tenant_id=conversation.tenant_id
              AND inbound.conversation_id=conversation.id
              AND inbound.direction='inbound' AND inbound.provider='meta'
            ORDER BY inbound.created_at DESC, inbound.updated_at DESC,
                     inbound.id DESC
            LIMIT 1
          ) latest_inbound ON true
          JOIN messaging.inbound_message_origins origin
            ON origin.tenant_id=conversation.tenant_id
           AND origin.message_id=latest_inbound.id
          JOIN crm.contact_channel_identities identity
            ON identity.id=origin.contact_identity_id
           AND identity.tenant_id=origin.tenant_id
           AND identity.contact_id=contact.id
           AND identity.channel='whatsapp'
           AND identity.validation_status='valid'
           AND identity.normalized_value=origin.sender_address
          WHERE conversation.id=${input.conversationId}::uuid
            AND conversation.removed_from_inbox_at IS NULL
            AND channel.provider_account_id=${channelConfiguration?.phoneNumberId ?? null}
            AND channel.configuration->>'phoneNumberId'=${channelConfiguration?.phoneNumberId ?? null}
            AND channel.configuration->>'wabaId'=${channelConfiguration?.wabaId ?? null}
            AND channel.configuration->>'graphApiVersion'=${channelConfiguration?.graphApiVersion ?? null}
            AND (${input.recipientIdentityId ?? null}::uuid IS NULL
              OR identity.id=${input.recipientIdentityId ?? null}::uuid)
            AND (${input.recipientAddress ?? null}::text IS NULL
              OR origin.sender_address=${input.recipientAddress ?? null})
          LIMIT 1
        `
        : await sql<ConversationContact[]>`
          SELECT conversation.id AS conversation_id,
                 conversation.channel_id, conversation.contact_id,
                 conversation.customer_service_window_expires_at,
                 conversation.ownership_epoch, contact.lifecycle_status,
                 contact.whatsapp_consent, contact.whatsapp_opted_out_at,
                 identity.id AS recipient_identity_id,
                 identity.normalized_value
          FROM messaging.conversations conversation
          JOIN messaging.channels channel
            ON channel.id=conversation.channel_id
           AND channel.tenant_id=conversation.tenant_id
           AND channel.kind='whatsapp' AND channel.provider='simulator'
           AND channel.status='active'
          JOIN crm.contacts contact ON contact.id=conversation.contact_id
           AND contact.tenant_id=conversation.tenant_id
          JOIN LATERAL (
            SELECT candidate.id, candidate.normalized_value
            FROM crm.contact_channel_identities candidate
            WHERE candidate.tenant_id=conversation.tenant_id
              AND candidate.contact_id=conversation.contact_id
              AND candidate.channel='whatsapp'
              AND candidate.validation_status='valid'
              AND candidate.normalized_value IS NOT NULL
            ORDER BY candidate.is_primary DESC, candidate.created_at,
                     candidate.id
            LIMIT 1
          ) identity ON true
          WHERE conversation.id=${input.conversationId}::uuid
            AND conversation.removed_from_inbox_at IS NULL
          LIMIT 1
        `;
  const contact = contacts[0];
  if (contact === undefined)
    throw new TypeError("conversation has no valid WhatsApp recipient");
  if (normalizeE164(contact.normalized_value) === undefined)
    throw new TypeError("recipient must be strict E.164");
  if (input.provider === "meta") {
    if (contact.whatsapp_opted_out_at !== null)
      throw new TypeError("recipient has opted out of WhatsApp messaging");
    if (
      contact.lifecycle_status !== "active" ||
      contact.whatsapp_consent !== "granted"
    )
      throw new TypeError("WhatsApp consent is required");
  }

  if (
    input.provider === "meta" &&
    input.kind === "text" &&
    (contact.customer_service_window_expires_at === null ||
      contact.customer_service_window_expires_at.getTime() <= Date.now())
  )
    throw new TypeError(
      "free-form text is outside the customer-service window; use an approved template",
    );

  const content = input.kind === "text" ? input.text.trim() : null;
  const structured =
    input.kind === "template"
      ? {
          templateName: input.templateName,
          language: input.language,
          parameters: input.parameters,
        }
      : undefined;
  const messages = await sql<{ id: string }[]>`
    INSERT INTO messaging.messages
      (tenant_id, conversation_id, direction, sender_type, sender_user_id,
       content_type, content_text, structured_content, provider, status)
    VALUES (platform.current_tenant_id(), ${contact.conversation_id}::uuid, 'outbound', ${input.senderType ?? "user"},
            ${input.senderUserId}::uuid, ${input.kind}, ${content},
            ${structured === undefined ? null : sql.json(structured)}, ${input.provider}, 'queued')
    RETURNING id
  `;
  const messageId = messages[0]?.id;
  if (messageId === undefined)
    throw new Error("outbound message insert failed");
  const requests = await sql<{ id: string }[]>`
    INSERT INTO messaging.outbound_requests
      (tenant_id, conversation_id, message_id, channel_id, recipient_identity_id, recipient_address,
       requested_by_user_id, provider, message_kind, template_name, template_language,
       template_parameters, explicitly_confirmed, idempotency_key, ai_ownership_epoch, request_fingerprint)
    VALUES (platform.current_tenant_id(), ${contact.conversation_id}::uuid, ${messageId}::uuid,
            ${contact.channel_id}::uuid, ${contact.recipient_identity_id}::uuid, ${contact.normalized_value},
            ${input.senderUserId}::uuid, ${input.provider}, ${input.kind},
            ${input.kind === "template" ? input.templateName : null},
            ${input.kind === "template" ? input.language : null},
            ${input.kind === "template" ? sql.json(input.parameters) : null},
            ${input.explicitlyConfirmed}, ${input.idempotencyKey},
            ${input.senderType === "agent" ? contact.ownership_epoch : null}, ${fingerprint})
    RETURNING id
  `;
  const requestId = requests[0]?.id;
  if (requestId === undefined)
    throw new Error("outbound request insert failed");
  // Admitting a human/agent reply acknowledges the inbound messages currently
  // visible to the operator. A later inbound webhook increments the counter
  // again, so the badge represents new customer activity after this reply.
  await sql`
    UPDATE messaging.conversations
    SET status = 'open', unread_count = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${contact.conversation_id}::uuid
  `;
  await sql`
    INSERT INTO ops.jobs
      (tenant_id, queue, job_type, reference_type, reference_id, payload,
       idempotency_key, max_attempts)
    VALUES (platform.current_tenant_id(), 'messaging', 'whatsapp.outbound.send',
            'outbound_request', ${requestId}::uuid,
            jsonb_build_object('requestId', ${requestId}::uuid),
            ${`whatsapp-outbound:${input.idempotencyKey}`}, 5)
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO audit.records
      (tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (platform.current_tenant_id(), ${input.senderUserId}::uuid,
            'whatsapp.outbound.queued', 'messaging.outbound_request', ${requestId}::uuid,
            ${sql.json({ provider: input.provider, kind: input.kind, explicitlyConfirmed: input.explicitlyConfirmed })})
  `;
  return {
    requestId,
    messageId,
    conversationId: contact.conversation_id,
    provider: input.provider,
    queued: true,
  };
}

export async function setWhatsAppConsent(
  sql: postgres.TransactionSql,
  contactId: string,
  consent: "unknown" | "granted" | "revoked",
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE crm.contacts SET whatsapp_consent = ${consent},
      whatsapp_opted_out_at = CASE
        WHEN ${consent} = 'revoked' THEN CURRENT_TIMESTAMP
        WHEN ${consent} = 'granted' THEN NULL
        ELSE whatsapp_opted_out_at END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${contactId}::uuid RETURNING id
  `;
  return rows.length === 1;
}
