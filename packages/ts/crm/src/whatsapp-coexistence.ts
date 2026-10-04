import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";

const fields = [
  "account_update",
  "history",
  "smb_app_state_sync",
  "smb_message_echoes",
] as const;
type CoexistenceField = (typeof fields)[number];
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function phone(value: unknown): string {
  const valueString = string(value).replace(/^\+/, "");
  return /^[1-9][0-9]{6,14}$/.test(valueString) ? valueString : "";
}
function timestamp(value: unknown): Date {
  const seconds = Number(value);
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds * 1000 > Date.now() + 300_000
  )
    throw new TypeError("invalid coexistence timestamp");
  return new Date(seconds * 1000);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(object(value))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export interface WhatsAppCoexistenceEnvelope {
  readonly field: CoexistenceField;
  readonly wabaId: string;
  readonly providerAccountId?: string;
  readonly providerEventId: string;
  readonly value: JsonObject;
}

/** Meta's documented Coexistence fields are deliberately separate from live ingress. */
export function parseWhatsAppCoexistenceEnvelopes(
  payload: unknown,
): WhatsAppCoexistenceEnvelope[] {
  const root = object(payload),
    result: WhatsAppCoexistenceEnvelope[] = [];
  for (const entryValue of array(root.entry)) {
    const entry = object(entryValue);
    for (const changeValue of array(entry.changes)) {
      const change = object(changeValue),
        field = change.field;
      if (!fields.includes(field as CoexistenceField)) continue;
      if (root.object !== "whatsapp_business_account" || !string(entry.id))
        throw new TypeError("invalid coexistence account");
      const value = object(change.value),
        account = string(object(value.metadata).phone_number_id);
      if (field !== "account_update" && !account)
        throw new TypeError("missing coexistence phone account");
      // A history notification may contain thousands of messages. Keep each
      // worker transaction bounded, retaining phase/progress/errors in receipts.
      const chunks: JsonObject[] = [];
      if (field === "history" && array(value.history).length > 0) {
        if (array(value.messages).length > 0)
          throw new TypeError("ambiguous coexistence history shape");
        for (const historyValue of array(value.history)) {
          const history = object(historyValue),
            threads = array(history.threads);
          if (threads.length === 0)
            chunks.push({ ...value, history: [history] });
          for (const threadValue of threads) {
            const thread = object(threadValue),
              messages = array(thread.messages);
            for (
              let offset = 0;
              offset < Math.max(messages.length, 1);
              offset += 100
            )
              chunks.push({
                ...value,
                history: [
                  {
                    ...history,
                    threads: [
                      {
                        ...thread,
                        messages: messages.slice(offset, offset + 100),
                      },
                    ],
                  },
                ],
              });
          }
        }
      } else {
        const listKey =
          field === "history"
            ? "messages"
            : field === "smb_message_echoes"
              ? "message_echoes"
              : field === "smb_app_state_sync"
                ? "state_sync"
                : undefined;
        const items = listKey ? array(value[listKey]) : [];
        if (!listKey || items.length === 0) chunks.push(value);
        else
          for (let offset = 0; offset < items.length; offset += 100)
            chunks.push({
              ...value,
              [listKey]: items.slice(offset, offset + 100),
            });
      }
      for (const chunk of chunks) {
        const digest = createHash("sha256")
          .update(
            canonical({
              waba: entry.id,
              field,
              value: chunk,
              time: entry.time ?? null,
            }),
          )
          .digest("hex");
        result.push({
          field: field as CoexistenceField,
          wabaId: string(entry.id),
          ...(account ? { providerAccountId: account } : {}),
          providerEventId: `coexistence:${String(field)}:${digest}`,
          value: chunk,
        });
      }
    }
  }
  return result;
}

/** Import only: no live inbound helper, service window, consent grant or jobs. */
export async function ingestWhatsAppCoexistence(
  sql: TransactionSql,
  payload: unknown,
): Promise<void> {
  const stored = object(payload),
    value = object(stored.value),
    field = string(stored.field);
  const rows = await sql<
    {
      channel_id: string;
      business_phone_number: string;
      enabled: boolean;
      disconnected_at: Date | null;
    }[]
  >`
    SELECT account.channel_id,account.business_phone_number,account.enabled,account.disconnected_at
    FROM platform.whatsapp_coexistence_accounts account JOIN messaging.channels channel
      ON channel.tenant_id=account.tenant_id AND channel.id=account.channel_id
    WHERE account.tenant_id=platform.current_tenant_id() AND account.waba_id=${string(stored.wabaId)}
      AND account.phone_number_id=${string(stored.providerAccountId)} AND channel.provider_account_id=account.phone_number_id
    FOR UPDATE OF channel`;
  const firstBinding = rows[0];
  if (!firstBinding) throw new TypeError("coexistence binding unavailable");
  const binding = firstBinding;
  // account_update has already applied its fail-closed fence in the receipt
  // transaction. Reconnection never silently restores sending authorization.
  if (
    field === "account_update" ||
    stored.importEnabled !== true ||
    !binding.enabled ||
    binding.disconnected_at
  )
    return;
  if (!fields.includes(field as CoexistenceField))
    throw new TypeError("invalid coexistence field");

  async function contact(customer: string, name?: string): Promise<string> {
    if (!customer) throw new TypeError("invalid coexistence customer");
    const normalized = `+${customer}`;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(platform.current_tenant_id()::text || ${normalized},0))`;
    const identities = await sql<
      { contact_id: string }[]
    >`SELECT contact_id FROM crm.contact_channel_identities WHERE tenant_id=platform.current_tenant_id() AND channel='whatsapp' AND normalized_value=${normalized}`;
    if (identities[0]) return identities[0].contact_id;
    const displayName = name?.trim().slice(0, 500) ?? "";
    const contacts = await sql<
      { id: string }[]
    >`INSERT INTO crm.contacts(tenant_id,name) VALUES(platform.current_tenant_id(),${displayName || normalized}) RETURNING id`;
    const id = contacts[0]?.id;
    if (!id) throw new Error("coexistence contact insert failed");
    await sql`INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,display_value,provider,provider_identity_id,validation_status,is_primary) VALUES(platform.current_tenant_id(),${id}::uuid,'whatsapp',${normalized},${normalized},'meta',${normalized},'unverified',true)`;
    return id;
  }

  if (field === "smb_app_state_sync") {
    for (const stateValue of array(value.state_sync)) {
      const state = object(stateValue),
        info = object(state.contact),
        customer = phone(info.phone_number);
      if (
        state.type !== "contact" ||
        !customer ||
        (state.action !== "add" && state.action !== "remove")
      )
        throw new TypeError("invalid coexistence contact state");
      const at = timestamp(object(state.metadata).timestamp),
        name = string(info.full_name) || string(info.first_name);
      const prior = await sql<
        { provider_timestamp: Date }[]
      >`SELECT provider_timestamp FROM messaging.whatsapp_app_contacts WHERE tenant_id=platform.current_tenant_id() AND channel_id=${binding.channel_id}::uuid AND phone_number=${customer} FOR UPDATE`;
      if (prior[0] && prior[0].provider_timestamp >= at) continue;
      const id = state.action === "add" ? await contact(customer, name) : null;
      await sql`INSERT INTO messaging.whatsapp_app_contacts(tenant_id,channel_id,phone_number,contact_id,display_name,state,provider_timestamp) VALUES(platform.current_tenant_id(),${binding.channel_id}::uuid,${customer},${id}::uuid,${name.slice(0, 500)},${string(state.action)},${at}) ON CONFLICT(tenant_id,channel_id,phone_number) DO UPDATE SET contact_id=COALESCE(EXCLUDED.contact_id,messaging.whatsapp_app_contacts.contact_id),display_name=EXCLUDED.display_name,state=EXCLUDED.state,provider_timestamp=EXCLUDED.provider_timestamp WHERE messaging.whatsapp_app_contacts.provider_timestamp<EXCLUDED.provider_timestamp`;
    }
    return;
  }

  async function message(
    raw: unknown,
    threadCustomer?: string,
    mediaFollowup = false,
  ): Promise<void> {
    const item = object(raw),
      id = string(item.id),
      from = phone(item.from);
    if (!id || id.length > 1000 || !from)
      throw new TypeError("invalid coexistence message");
    const existing = await sql<
      {
        id: string;
        conversation_id: string;
        channel_id: string;
        customer_phone: string | null;
        provider_payload: JsonObject | null;
      }[]
    >`SELECT message.id,message.conversation_id,conversation.channel_id,message.provider_payload,(SELECT normalized_value FROM crm.contact_channel_identities identity WHERE identity.tenant_id=conversation.tenant_id AND identity.contact_id=conversation.contact_id AND identity.channel='whatsapp' LIMIT 1) customer_phone FROM messaging.messages message JOIN messaging.conversations conversation ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id WHERE message.tenant_id=platform.current_tenant_id() AND message.provider='meta' AND message.provider_message_id=${id} FOR UPDATE OF message`;
    const prior = existing[0];
    if (prior && prior.channel_id !== binding.channel_id)
      throw new TypeError("coexistence message belongs to another channel");
    if (
      prior &&
      from !== binding.business_phone_number &&
      from !== phone(prior.customer_phone)
    )
      throw new TypeError("coexistence message sender mismatch");
    const origin =
      field === "history"
        ? "whatsapp_business_app_history"
        : "whatsapp_business_app";
    const rawType = string(item.type),
      supported = [
        "text",
        "image",
        "audio",
        "video",
        "document",
        "location",
        "interactive",
      ];
    const contentType = supported.includes(rawType) ? rawType : "event";
    const media = object(item[rawType]);
    const content = {
      origin,
      providerMessageType: rawType,
      retrievalStatus: "unavailable",
      ...(string(media.id) ? { providerMediaId: string(media.id) } : {}),
      ...(string(media.mime_type) ? { mimeType: string(media.mime_type) } : {}),
      ...(string(media.caption) ? { caption: string(media.caption) } : {}),
    };
    if (prior) {
      // A Cloud API send may be echoed. Preserve its provenance/ownership.
      // Media follow-ups enrich only records imported through this path.
      if (
        mediaFollowup &&
        object(prior.provider_payload).origin ===
          "whatsapp_business_app_history"
      )
        await sql`UPDATE messaging.messages SET content_type=${contentType},structured_content=${sql.json(content)},updated_at=CURRENT_TIMESTAMP WHERE tenant_id=platform.current_tenant_id() AND id=${prior.id}::uuid`;
      return;
    }
    // A media follow-up can arrive before its history chunk. Retain the receipt
    // for retry rather than create a conversation with an invented direction.
    if (mediaFollowup)
      throw new TypeError("coexistence media awaits history message");
    const outbound = from === binding.business_phone_number;
    const customer =
      field === "smb_message_echoes" ? phone(item.to) : threadCustomer;
    if (
      !customer ||
      customer === binding.business_phone_number ||
      (field === "smb_message_echoes" && !outbound) ||
      (!outbound && from !== customer)
    )
      throw new TypeError("coexistence sender does not match bound account");
    const at = timestamp(item.timestamp),
      contactId = await contact(customer);
    const conversations = await sql<
      { id: string }[]
    >`INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id,status,ownership_mode) VALUES(platform.current_tenant_id(),${binding.channel_id}::uuid,${contactId}::uuid,${field === "history" ? "closed" : "open"},'human') ON CONFLICT(tenant_id,channel_id,contact_id) DO UPDATE SET updated_at=messaging.conversations.updated_at RETURNING id`;
    const conversation = conversations[0]?.id;
    if (!conversation)
      throw new Error("coexistence conversation insert failed");
    const text = (
      string(object(item.text).body) || string(media.caption)
    ).slice(0, 65536);
    await sql`INSERT INTO messaging.messages(tenant_id,conversation_id,direction,sender_type,sender_contact_id,content_type,content_text,structured_content,provider,provider_message_id,status,provider_payload,created_at) VALUES(platform.current_tenant_id(),${conversation}::uuid,${outbound ? "outbound" : "inbound"},${outbound ? "user" : "contact"},${outbound ? null : contactId}::uuid,${contentType},${text || null},${sql.json(content)},'meta',${id},${outbound ? "sent" : "received"},${sql.json({ origin, coexistenceReceiptId: string(stored.receiptId) })},${at})`;
    await sql`UPDATE messaging.conversations SET last_message_at=${at},last_message_preview=${text.slice(0, 200) || `[${rawType || "Message"}]`},updated_at=CURRENT_TIMESTAMP WHERE tenant_id=platform.current_tenant_id() AND id=${conversation}::uuid AND (last_message_at IS NULL OR last_message_at<${at})`;
    if (field === "smb_message_echoes")
      await sql`UPDATE messaging.conversations SET ownership_mode='human',ownership_epoch=ownership_epoch+1,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=platform.current_tenant_id() AND id=${conversation}::uuid AND ownership_mode<>'human'`;
  }
  if (field === "smb_message_echoes") {
    for (const item of array(value.message_echoes)) await message(item);
  } else {
    for (const historyValue of array(value.history))
      for (const threadValue of array(object(historyValue).threads)) {
        const thread = object(threadValue);
        for (const item of array(thread.messages))
          await message(item, phone(thread.id));
      }
    for (const item of array(value.messages))
      await message(item, undefined, true);
  }
}
