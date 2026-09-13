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
      readonly senderUserId: string;
      readonly senderType?: "user" | "agent";
      readonly text: string;
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
      readonly senderUserId: string;
      readonly senderType?: "user" | "agent";
      readonly templateName: string;
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
  contact_id: string;
  lifecycle_status: string;
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

async function ensureChannel(
  sql: postgres.TransactionSql,
  provider: "simulator" | "meta",
  configuration: WhatsAppChannelConfiguration | undefined,
): Promise<string> {
  if (provider === "meta" && configuration === undefined)
    throw new TypeError("real WhatsApp channel is not configured");
  if (provider === "simulator") {
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM messaging.channels
      WHERE tenant_id = platform.current_tenant_id() AND provider = 'simulator'
      ORDER BY created_at LIMIT 1
    `;
    if (existing[0]?.id !== undefined) return existing[0].id;
  }
  const accountId =
    provider === "meta" ? configuration?.phoneNumberId : undefined;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO messaging.channels
      (tenant_id, kind, provider, provider_account_id, display_address, status, configuration)
    VALUES (
      platform.current_tenant_id(), 'whatsapp', ${provider},
      ${accountId ?? null},
      ${provider === "meta" ? "Meta WhatsApp Cloud API" : "WhatsApp simulator"},
      'active',
      ${sql.json(
        provider === "meta"
          ? {
              graphApiVersion: configuration?.graphApiVersion,
              phoneNumberId: configuration?.phoneNumberId,
              wabaId: configuration?.wabaId,
            }
          : { mode: "simulator" },
      )}
    )
    ON CONFLICT (provider, provider_account_id) WHERE provider_account_id IS NOT NULL
    DO UPDATE SET configuration = EXCLUDED.configuration, status = 'active',
                  updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `;
  if (rows[0]?.id !== undefined) return rows[0].id;
  const simulator = await sql<{ id: string }[]>`
    SELECT id FROM messaging.channels
    WHERE tenant_id = platform.current_tenant_id() AND provider = 'simulator'
    ORDER BY created_at LIMIT 1
  `;
  const id = simulator[0]?.id;
  if (id === undefined) throw new Error("WhatsApp channel resolution failed");
  return id;
}

export async function queueWhatsAppOutbound(
  sql: postgres.TransactionSql,
  input: WhatsAppOutboundInput,
  channelConfiguration?: WhatsAppChannelConfiguration,
): Promise<QueuedWhatsAppOutbound> {
  validateInput(input);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        conversationId: input.conversationId,
        provider: input.provider,
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
  // Serialize only equal tenant/key admissions; no network I/O in this transaction.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(platform.current_tenant_id()::text || ':' || ${input.idempotencyKey}, 0))`;
  const existing = await sql<
    {
      id: string;
      message_id: string;
      conversation_id: string;
      provider: "simulator" | "meta";
      request_fingerprint: string | null;
    }[]
  >`
    SELECT id, message_id, conversation_id, provider, request_fingerprint
    FROM messaging.outbound_requests
    WHERE tenant_id = platform.current_tenant_id()
      AND idempotency_key = ${input.idempotencyKey}
  `;
  if (existing[0] !== undefined) {
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

  const contacts = await sql<ConversationContact[]>`
    SELECT conversation.contact_id, contact.lifecycle_status,
           contact.whatsapp_consent, contact.whatsapp_opted_out_at,
           identity.id AS recipient_identity_id, identity.normalized_value
    FROM messaging.conversations conversation
    JOIN crm.contacts contact ON contact.id = conversation.contact_id
      AND contact.tenant_id = conversation.tenant_id
    JOIN LATERAL (
      SELECT id, normalized_value
      FROM crm.contact_channel_identities
      WHERE tenant_id = conversation.tenant_id
        AND contact_id = conversation.contact_id
        AND channel = 'whatsapp' AND validation_status = 'valid'
        AND normalized_value IS NOT NULL
      ORDER BY is_primary DESC, created_at, id LIMIT 1
    ) identity ON true
    WHERE conversation.id = ${input.conversationId}::uuid
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

  const channelId = await ensureChannel(
    sql,
    input.provider,
    channelConfiguration,
  );
  const conversations = await sql<
    {
      id: string;
      customer_service_window_expires_at: Date | null;
      ownership_epoch: string;
    }[]
  >`
    INSERT INTO messaging.conversations (tenant_id, channel_id, contact_id, status)
    VALUES (platform.current_tenant_id(), ${channelId}::uuid, ${contact.contact_id}::uuid, 'open')
    ON CONFLICT (tenant_id, channel_id, contact_id)
    DO UPDATE SET status = 'open', updated_at = CURRENT_TIMESTAMP
    RETURNING id, customer_service_window_expires_at, ownership_epoch
  `;
  const conversation = conversations[0];
  if (conversation === undefined)
    throw new Error("outbound conversation resolution failed");
  if (
    input.provider === "meta" &&
    input.kind === "text" &&
    (conversation.customer_service_window_expires_at === null ||
      conversation.customer_service_window_expires_at.getTime() <= Date.now())
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
    VALUES (platform.current_tenant_id(), ${conversation.id}::uuid, 'outbound', ${input.senderType ?? "user"},
            ${input.senderUserId}::uuid, ${input.kind}, ${content},
            ${structured === undefined ? null : sql.json(structured)}, ${input.provider}, 'queued')
    RETURNING id
  `;
  const messageId = messages[0]?.id;
  if (messageId === undefined)
    throw new Error("outbound message insert failed");
  const requests = await sql<{ id: string }[]>`
    INSERT INTO messaging.outbound_requests
      (tenant_id, conversation_id, message_id, channel_id, recipient_identity_id,
       requested_by_user_id, provider, message_kind, template_name, template_language,
       template_parameters, explicitly_confirmed, idempotency_key, ai_ownership_epoch, request_fingerprint)
    VALUES (platform.current_tenant_id(), ${conversation.id}::uuid, ${messageId}::uuid,
            ${channelId}::uuid, ${contact.recipient_identity_id}::uuid,
            ${input.senderUserId}::uuid, ${input.provider}, ${input.kind},
            ${input.kind === "template" ? input.templateName : null},
            ${input.kind === "template" ? input.language : null},
            ${input.kind === "template" ? sql.json(input.parameters) : null},
            ${input.explicitlyConfirmed}, ${input.idempotencyKey},
            ${input.senderType === "agent" ? conversation.ownership_epoch : null}, ${fingerprint})
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
    SET unread_count = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${conversation.id}::uuid
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
    conversationId: conversation.id,
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
