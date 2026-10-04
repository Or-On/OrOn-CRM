import { loadConfig } from "@or-on/config";
import { requireTenantFeature } from "@or-on/crm";
import { withCurrentTenant } from "../auth";
import { parseTemplates } from "./catalog";

/** Resolve from an authorized conversation, never a caller supplied account. */
export async function conversationTemplateAccount(conversationId: string) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(conversationId))
    throw new TypeError("invalid conversation identifier");
  const phoneNumberId = await withCurrentTenant(
    "messaging:operate",
    async (sql) => {
      await requireTenantFeature(sql, "whatsapp");
      const rows = await sql<{ provider_account_id: string | null }[]>`
      SELECT channel.provider_account_id
      FROM messaging.conversations conversation
      JOIN messaging.channels channel ON channel.tenant_id = conversation.tenant_id
        AND channel.id = conversation.channel_id
      WHERE conversation.tenant_id = platform.current_tenant_id()
        AND conversation.id = ${conversationId}::uuid
        AND channel.provider = 'meta' AND channel.status = 'active'
      LIMIT 1
    `;
      return rows[0]?.provider_account_id;
    },
  );
  const config = loadConfig(process.env, { service: "web" });
  if (!config.enableRealWhatsApp)
    throw new Error("template_catalog_provider_disabled");
  if (!phoneNumberId) throw new Error("template_catalog_channel_unavailable");
  const additional = config.whatsAppAdditionalAccounts.find(
    (account) => account.phoneNumberId === phoneNumberId,
  );
  if (additional) return additional;
  if (
    config.whatsApp.phoneNumberId !== phoneNumberId ||
    !config.whatsApp.wabaId ||
    !config.whatsApp.graphApiVersion ||
    !config.secrets.whatsappAccessToken
  )
    throw new Error("template_catalog_account_unavailable");
  return {
    phoneNumberId,
    wabaId: config.whatsApp.wabaId,
    graphApiVersion: config.whatsApp.graphApiVersion,
    accessToken: config.secrets.whatsappAccessToken,
  };
}

export async function readConversationTemplates(
  conversationId: string,
  after?: string,
) {
  const account = await conversationTemplateAccount(conversationId);
  const parameters = new URLSearchParams({
    fields: "name,language,status,components",
    limit: "100",
  });
  if (after) parameters.set("after", after);
  // No global cache: catalog data and credentials never survive a tenant/account change.
  const response = await fetch(
    `https://graph.facebook.com/${account.graphApiVersion}/${account.wabaId}/message_templates?${parameters}`,
    {
      headers: { authorization: `Bearer ${account.accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "template_catalog_rate_limited"
        : "template_catalog_provider_unavailable",
    );
  const payload: unknown = await response.json();
  const paging = (
    payload as { paging?: { next?: unknown; cursors?: { after?: unknown } } }
  ).paging;
  return {
    templates: parseTemplates(payload),
    nextCursor:
      paging?.next && typeof paging.cursors?.after === "string"
        ? paging.cursors.after
        : null,
  };
}
