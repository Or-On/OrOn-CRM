import type postgres from "postgres";
import { planWhatsAppAutoGreeting, queueWhatsAppOutbound } from "@or-on/crm";

/**
 * Queue the channel's automatic greeting for one committed inbound message.
 *
 * It runs inside the ingress transaction but in its own savepoint: a refused
 * or failed greeting (revoked consent, missing channel binding) is recorded
 * and dropped, never a reason to retry or lose the customer's message. The
 * greeting is an ordinary system template, so the outbound pipeline applies
 * its usual consent, recipient and sender checks again before delivery.
 */
export async function queueAutoGreeting(
  transaction: postgres.TransactionSql,
  messageId: string,
): Promise<boolean> {
  let conversationId: string | undefined;
  try {
    return await transaction.savepoint(async (savepoint) => {
      const plan = await planWhatsAppAutoGreeting(savepoint, messageId);
      if (plan?.provider !== "meta") return false;
      conversationId = plan.conversationId;
      if (plan.channelConfiguration === undefined)
        throw new TypeError("WhatsApp channel configuration is incomplete");
      await savepoint`SELECT set_config('app.current_user', ${plan.actorUserId}, true)`;
      const queued = await queueWhatsAppOutbound(
        savepoint,
        {
          conversationId: plan.conversationId,
          explicitlyConfirmed: true,
          idempotencyKey: `auto-greeting:${messageId}`,
          kind: "template",
          templateName: plan.templateName,
          language: plan.language,
          parameters: [],
          provider: "meta",
          realProviderEnabled: true,
          senderUserId: plan.actorUserId,
          senderType: "system",
          acknowledgesInbound: false,
        },
        plan.channelConfiguration,
      );
      await savepoint`SELECT set_config('app.current_user', '', true)`;
      return queued.queued;
    });
  } catch (error) {
    if (conversationId !== undefined)
      await transaction`
        INSERT INTO audit.records(
          tenant_id, actor_service, action, target_type, target_id, metadata
        ) VALUES (
          platform.current_tenant_id(), 'messaging-worker',
          'whatsapp.auto_greeting.skipped', 'conversation', ${conversationId}::uuid,
          ${transaction.json({
            messageId,
            reason:
              error instanceof TypeError
                ? error.message.slice(0, 200)
                : "auto_greeting_failed",
          })}
        )
      `;
    return false;
  }
}
