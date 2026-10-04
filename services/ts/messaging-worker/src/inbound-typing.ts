import type postgres from "postgres";
import { remediationEnabled } from "./remediation-policy.js";
import type { WhatsAppProvider } from "./providers.js";
import type { ChannelCredentialEnvelope } from "./channel-credentials.js";

/** Advisory delivery cannot change committed ingress or customer ownership. */
export async function acknowledgeCommittedInbound(
  sql: postgres.Sql,
  provider: WhatsAppProvider,
  input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageId: string;
  },
  resolveChannelCredential?: (envelope: ChannelCredentialEnvelope) => string,
): Promise<void> {
  if (provider.acknowledgeInbound === undefined) return;
  const resolve = async (epoch?: string) =>
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant',${input.tenantId},true),set_config('app.current_role','service',true)`;
      if (!(await remediationEnabled(tx, "typing"))) return undefined;
      const rows = await tx<
        {
          epoch: string;
          phone_number_id: string;
          provider_message_id: string;
        }[]
      >`
      SELECT c.ownership_epoch::text epoch,ch.configuration->>'phoneNumberId' phone_number_id,
             m.provider_message_id
      FROM messaging.conversations c
      JOIN messaging.channels ch ON ch.id=c.channel_id AND ch.tenant_id=c.tenant_id
      JOIN messaging.messages m ON m.conversation_id=c.id AND m.tenant_id=c.tenant_id
      JOIN agents.agent_profile_versions a ON a.id=c.ai_agent_profile_version_id AND a.tenant_id=c.tenant_id
      WHERE c.id=${input.conversationId}::uuid AND m.id=${input.messageId}::uuid
        AND c.tenant_id=platform.current_tenant_id() AND c.ownership_mode='ai'
        AND (${epoch ?? null}::bigint IS NULL OR c.ownership_epoch=${epoch ?? null}::bigint)
        AND c.removed_from_inbox_at IS NULL AND ch.provider='meta' AND ch.status='active'
        AND m.direction='inbound' AND m.status='received' AND m.provider='meta'
        AND a.published_at IS NOT NULL AND a.validation_status='valid'
        AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
        AND NOT EXISTS (SELECT 1 FROM messaging.messages newer WHERE newer.conversation_id=c.id
          AND newer.direction='inbound' AND newer.status='received' AND newer.created_at>m.created_at)
    `;
      return rows[0];
    });
  const admitted = await resolve();
  if (!admitted?.phone_number_id || !admitted.provider_message_id) return;
  await provider.acknowledgeInbound({
    senderPhoneNumberId: admitted.phone_number_id,
    providerMessageId: admitted.provider_message_id,
    accessTokenForAttempt: async () => {
      const current = await resolve(admitted.epoch);
      if (
        current?.phone_number_id !== admitted.phone_number_id ||
        current.provider_message_id !== admitted.provider_message_id
      )
        throw new Error("inbound acknowledgement authorization changed");
      return sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant',${input.tenantId},true),set_config('app.current_role','service',true)`;
        const projected = await tx<
          { envelope: ChannelCredentialEnvelope | { legacy: true } | null }[]
        >`SELECT platform.messaging_typing_channel_credential(${input.messageId}::uuid,${admitted.epoch}::bigint) AS envelope`;
        const envelope = projected[0]?.envelope;
        if (envelope === undefined || envelope === null)
          throw new Error("channel_credential_unavailable");
        if ("legacy" in envelope) return undefined;
        if (resolveChannelCredential === undefined)
          throw new Error("channel_credential_unavailable");
        return resolveChannelCredential(envelope);
      });
    },
    beforeAttempt: async () => {
      const current = await resolve(admitted.epoch);
      if (
        current?.phone_number_id !== admitted.phone_number_id ||
        current.provider_message_id !== admitted.provider_message_id
      )
        throw new Error("inbound acknowledgement authorization changed");
    },
  });
}
