import type postgres from "postgres";

import type { WhatsAppChannelConfiguration } from "./whatsapp-outbound.js";

/**
 * The approved template a WhatsApp channel sends automatically when a
 * customer starts a new conversation. Languages are the variants the template
 * is approved in, captured from the provider catalog when it was saved.
 */
export interface WhatsAppAutoGreeting {
  readonly channelId: string;
  readonly enabled: boolean;
  readonly templateName: string;
  readonly languages: readonly string[];
  readonly fallbackLanguage: string;
  readonly updatedAt: string;
}

export interface WhatsAppAutoGreetingInput {
  readonly enabled: boolean;
  readonly templateName: string;
  readonly languages: readonly string[];
  readonly fallbackLanguage: string;
}

/** What the messaging worker queues for one inbound message. */
export interface WhatsAppAutoGreetingPlan {
  readonly conversationId: string;
  readonly templateName: string;
  readonly language: string;
  readonly actorUserId: string;
  readonly provider: "meta" | "simulator";
  readonly channelConfiguration?: WhatsAppChannelConfiguration;
}

const templateNamePattern = /^[a-z0-9_]{1,512}$/u;
const languagePattern = /^[a-z]{2,3}(?:_[A-Z]{2})?$/u;

async function requireTemplates(sql: postgres.TransactionSql): Promise<void> {
  const rows = await sql<{ enabled: boolean }[]>`
    SELECT platform.whatsapp_templates_enabled() AS enabled
  `;
  if (rows[0]?.enabled !== true)
    throw Object.assign(new Error("WhatsApp templates are unavailable"), {
      code: "42501",
    });
}

export function parseWhatsAppAutoGreetingInput(
  value: unknown,
): WhatsAppAutoGreetingInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Automatic greeting settings must be an object");
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean")
    throw new TypeError("Choose whether the automatic greeting is on");
  if (
    typeof input.templateName !== "string" ||
    !templateNamePattern.test(input.templateName)
  )
    throw new TypeError("Choose an approved template");
  if (
    !Array.isArray(input.languages) ||
    input.languages.length === 0 ||
    input.languages.length > 20 ||
    input.languages.some(
      (language) =>
        typeof language !== "string" || !languagePattern.test(language),
    )
  )
    throw new TypeError("The template has no approved language");
  const languages = [...new Set(input.languages as string[])];
  if (
    typeof input.fallbackLanguage !== "string" ||
    !languages.includes(input.fallbackLanguage)
  )
    throw new TypeError("Choose the default language from the template's");
  return {
    enabled: input.enabled,
    templateName: input.templateName,
    languages,
    fallbackLanguage: input.fallbackLanguage,
  };
}

/** The WhatsApp channel of a conversation that is still in the Inbox. */
export async function whatsAppConversationChannel(
  sql: postgres.TransactionSql,
  conversationId: string,
): Promise<string> {
  const rows = await sql<{ channel_id: string }[]>`
    SELECT channel.id AS channel_id
    FROM messaging.conversations conversation
    JOIN messaging.channels channel
      ON channel.tenant_id=conversation.tenant_id AND channel.id=conversation.channel_id
    WHERE conversation.id=${conversationId}::uuid
      AND conversation.tenant_id=platform.current_tenant_id()
      AND conversation.removed_from_inbox_at IS NULL
      AND channel.kind='whatsapp'
  `;
  const channelId = rows[0]?.channel_id;
  if (channelId === undefined)
    throw Object.assign(new Error("Conversation unavailable"), {
      code: "P0002",
    });
  return channelId;
}

interface GreetingRow {
  channel_id: string;
  enabled: boolean;
  template_name: string;
  languages: string[];
  fallback_language: string;
  updated_at: Date;
}

function greeting(row: GreetingRow): WhatsAppAutoGreeting {
  return {
    channelId: row.channel_id,
    enabled: row.enabled,
    templateName: row.template_name,
    languages: row.languages,
    fallbackLanguage: row.fallback_language,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getWhatsAppAutoGreeting(
  sql: postgres.TransactionSql,
  channelId: string,
): Promise<WhatsAppAutoGreeting | null> {
  await requireTemplates(sql);
  const rows = await sql<GreetingRow[]>`
    SELECT channel_id, enabled, template_name, languages, fallback_language, updated_at
    FROM messaging.whatsapp_auto_greetings
    WHERE tenant_id=platform.current_tenant_id() AND channel_id=${channelId}::uuid
  `;
  return rows[0] === undefined ? null : greeting(rows[0]);
}

export async function saveWhatsAppAutoGreeting(
  sql: postgres.TransactionSql,
  actorUserId: string,
  channelId: string,
  input: WhatsAppAutoGreetingInput,
): Promise<WhatsAppAutoGreeting> {
  await requireTemplates(sql);
  const rows = await sql<GreetingRow[]>`
    INSERT INTO messaging.whatsapp_auto_greetings(
      tenant_id, channel_id, enabled, template_name, languages,
      fallback_language, updated_by_user_id, updated_at
    ) VALUES (
      platform.current_tenant_id(), ${channelId}::uuid, ${input.enabled},
      ${input.templateName}, ${input.languages as string[]}::text[],
      ${input.fallbackLanguage}, ${actorUserId}::uuid, clock_timestamp()
    )
    ON CONFLICT (tenant_id, channel_id) DO UPDATE SET
      enabled=EXCLUDED.enabled, template_name=EXCLUDED.template_name,
      languages=EXCLUDED.languages, fallback_language=EXCLUDED.fallback_language,
      updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=EXCLUDED.updated_at
    RETURNING channel_id, enabled, template_name, languages, fallback_language, updated_at
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("Automatic greeting was not saved");
  await sql`
    INSERT INTO audit.records(
      tenant_id, actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid,
      'whatsapp.auto_greeting.updated', 'messaging.channel', ${channelId}::uuid,
      ${sql.json({
        enabled: input.enabled,
        templateName: input.templateName,
        languages: [...input.languages],
        fallbackLanguage: input.fallbackLanguage,
      })}
    )
  `;
  return greeting(row);
}

const scripts: readonly (readonly [string, RegExp])[] = [
  ["he", /[א-ת]/gu],
  ["ar", /[ؠ-ي]/gu],
  ["ru", /[А-я]/gu],
  ["en", /[a-z]/giu],
];

/**
 * The approved variant matching the script of the customer's own message.
 * Letters decide it: the dominant script with at least two letters picks a
 * language family, then the exact code or a regional variant of it. Anything
 * else, including media without a caption, uses the configured default.
 */
export function greetingLanguage(
  text: string,
  languages: readonly string[],
  fallback: string,
): string {
  let family: string | undefined;
  let best = 1;
  for (const [code, letters] of scripts) {
    const count = text.match(letters)?.length ?? 0;
    if (count > best) {
      best = count;
      family = code;
    }
  }
  if (family === undefined) return fallback;
  if (languages.includes(family)) return family;
  const regional = languages
    .filter((language) => language.startsWith(`${family}_`))
    .toSorted();
  return regional[0] ?? fallback;
}

function channelConfiguration(
  value: unknown,
): WhatsAppChannelConfiguration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const configuration = value as Record<string, unknown>;
  return typeof configuration.graphApiVersion === "string" &&
    typeof configuration.phoneNumberId === "string" &&
    typeof configuration.wabaId === "string"
    ? {
        graphApiVersion: configuration.graphApiVersion,
        phoneNumberId: configuration.phoneNumberId,
        wabaId: configuration.wabaId,
      }
    : undefined;
}

/** Whether, and in which language, this inbound message gets the greeting. */
export async function planWhatsAppAutoGreeting(
  sql: postgres.TransactionSql,
  messageId: string,
): Promise<WhatsAppAutoGreetingPlan | undefined> {
  const policy = await sql<{ enabled: boolean }[]>`
    SELECT platform.whatsapp_templates_enabled() AS enabled
  `;
  if (policy[0]?.enabled !== true) return undefined;
  const rows = await sql<{ plan: Record<string, unknown> | null }[]>`
    SELECT messaging.auto_greeting_for_inbound(${messageId}::uuid) AS plan
  `;
  const plan = rows[0]?.plan;
  if (plan === null || plan === undefined) return undefined;
  const languages = Array.isArray(plan.languages)
    ? plan.languages.filter(
        (language): language is string => typeof language === "string",
      )
    : [];
  if (
    typeof plan.conversationId !== "string" ||
    typeof plan.templateName !== "string" ||
    typeof plan.fallbackLanguage !== "string" ||
    typeof plan.actorUserId !== "string" ||
    (plan.provider !== "meta" && plan.provider !== "simulator") ||
    languages.length === 0
  )
    return undefined;
  const configuration = channelConfiguration(plan.channelConfiguration);
  return {
    conversationId: plan.conversationId,
    templateName: plan.templateName,
    language: greetingLanguage(
      typeof plan.text === "string" ? plan.text : "",
      languages,
      plan.fallbackLanguage,
    ),
    actorUserId: plan.actorUserId,
    provider: plan.provider,
    ...(configuration === undefined
      ? {}
      : { channelConfiguration: configuration }),
  };
}
