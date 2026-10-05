import "server-only";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import {
  channelCredentialKeys,
  createChannelCredentialResolver,
} from "@or-on/auth";
import { loadConfig } from "@or-on/config";
import type { WhatsAppTemplate } from "../inbox-templates";
import {
  createTemplateCatalog,
  type TemplateAccount,
} from "./catalog-provider";

const catalog = createTemplateCatalog();

export async function templateAccount(
  sql: postgres.TransactionSql,
  conversationId: string,
): Promise<TemplateAccount> {
  const policy = await sql<{ enabled: boolean }[]>`
    SELECT platform.whatsapp_templates_enabled() AS enabled
  `;
  if (policy[0]?.enabled !== true)
    throw Object.assign(new Error("WhatsApp templates are unavailable"), {
      code: "42501",
    });
  const rows = await sql<
    {
      tenant_id: string;
      channel_id: string;
      phone_id: string;
      waba_id: string;
      graph_version: string;
      credential_id: string | null;
      credential_kind: string | null;
      algorithm: string | null;
      key_version: string | null;
      ciphertext: string | null;
      nonce: string | null;
    }[]
  >`
    SELECT conversation.tenant_id, channel.id AS channel_id,
      channel.provider_account_id AS phone_id, channel.configuration->>'wabaId' AS waba_id,
      channel.configuration->>'graphApiVersion' AS graph_version, channel.credential_id,
      record.kind AS credential_kind, record.algorithm, record.key_version,
      encode(record.ciphertext,'hex') AS ciphertext, encode(record.nonce,'hex') AS nonce
    FROM messaging.conversations conversation JOIN messaging.channels channel
      ON channel.tenant_id=conversation.tenant_id AND channel.id=conversation.channel_id
    LEFT JOIN platform.credential_records record
      ON record.id=channel.credential_id AND record.tenant_id=channel.tenant_id
    WHERE conversation.id=${conversationId}::uuid
      AND conversation.tenant_id=platform.current_tenant_id()
      AND conversation.removed_from_inbox_at IS NULL
      AND channel.kind='whatsapp' AND channel.provider='meta' AND channel.status='active'
      AND channel.configuration->>'phoneNumberId'=channel.provider_account_id
      AND platform.current_tenant_feature_enabled('whatsapp')
    FOR SHARE OF conversation, channel`;
  const row = rows[0];
  if (!row)
    throw Object.assign(new Error("Conversation unavailable"), {
      code: "P0002",
    });
  if (row.credential_id !== null) {
    const accessToken = createChannelCredentialResolver(
      channelCredentialKeys(process.env),
      0,
    )({
      tenantId: row.tenant_id,
      channelId: row.channel_id,
      credentialId: row.credential_id,
      kind: row.credential_kind ?? "",
      algorithm: row.algorithm,
      keyVersion: row.key_version,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
    });
    return {
      tenantId: row.tenant_id,
      channelId: row.channel_id,
      wabaId: row.waba_id,
      graphApiVersion: row.graph_version,
      accessToken,
      bindingFingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            row.credential_id,
            row.credential_kind,
            row.algorithm,
            row.key_version,
            row.ciphertext,
            row.nonce,
          ]),
        )
        .digest("hex"),
    };
  }
  const config = loadConfig(process.env, { service: "web" });
  const primary =
    config.whatsApp.phoneNumberId === row.phone_id
      ? {
          phoneNumberId: config.whatsApp.phoneNumberId,
          wabaId: config.whatsApp.wabaId,
          graphApiVersion: config.whatsApp.graphApiVersion,
          accessToken: config.secrets.whatsappAccessToken,
        }
      : undefined;
  const account =
    primary ??
    config.whatsAppAdditionalAccounts.find(
      (entry) => entry.phoneNumberId === row.phone_id,
    );
  if (
    !account?.accessToken ||
    account.wabaId !== row.waba_id ||
    account.graphApiVersion !== row.graph_version
  )
    throw new Error("Template catalog account unavailable");
  return {
    tenantId: row.tenant_id,
    channelId: row.channel_id,
    wabaId: row.waba_id,
    graphApiVersion: row.graph_version,
    accessToken: account.accessToken,
  };
}

/** Network runs outside DB transactions; the caller freshly authorizes each projection. */
export async function listConversationTemplates(
  resolveAccount: () => Promise<TemplateAccount>,
  after: string | null,
) {
  const account = await resolveAccount();
  const page = await catalog(account, after);
  const current = await resolveAccount();
  if (JSON.stringify(current) !== JSON.stringify(account))
    throw new Error("Template catalog binding changed");
  return page;
}

/** Every catalog page, bounded, for decisions that need the whole catalog. */
export async function listAllConversationTemplates(
  resolveAccount: () => Promise<TemplateAccount>,
  maximumPages = 10,
): Promise<readonly WhatsAppTemplate[]> {
  const templates: WhatsAppTemplate[] = [];
  let after: string | null = null;
  for (let page = 0; page < maximumPages; page++) {
    const result = await listConversationTemplates(resolveAccount, after);
    templates.push(...result.templates);
    if (result.after === null) return templates;
    after = result.after;
  }
  throw new Error("Template catalog is too large to read completely");
}
