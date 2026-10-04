import type postgres from "postgres";

/** Caller supplies authenticated tenant transaction and persisted IDs, never model IDs. */
export async function queueDebouncedReply(
  tx: postgres.TransactionSql,
  input: { conversationId: string; messageId: string; eventId: string },
): Promise<{ handled: boolean; jobId?: string }> {
  const flags = await tx<
    { flag_key: string }[]
  >`SELECT flag_key FROM platform.tenant_remediation_flags WHERE tenant_id=platform.current_tenant_id() AND enabled AND flag_key IN ('debounce','queue_priority')`;
  if (!flags.some((f) => f.flag_key === "debounce")) return { handled: false };
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(platform.current_tenant_id()::text||':wa-debounce:'||${input.conversationId},19))`;
  const admitted = await tx<
    { id: string }[]
  >`SELECT m.id FROM messaging.messages m JOIN messaging.conversations c ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
    JOIN messaging.channels ch ON ch.id=c.channel_id AND ch.tenant_id=c.tenant_id
    JOIN ops.inbound_events e ON e.id=${input.eventId}::uuid AND e.tenant_id=m.tenant_id AND e.provider_account_id=ch.provider_account_id AND e.payload->>'providerMessageId'=m.provider_message_id
    WHERE m.id=${input.messageId}::uuid AND c.id=${input.conversationId}::uuid AND c.tenant_id=platform.current_tenant_id() AND m.direction='inbound' AND m.status='received' AND c.ownership_mode='ai'`;
  if (admitted.length !== 1) return { handled: true };
  const priority = flags.some((f) => f.flag_key === "queue_priority") ? 100 : 0;
  // A retry has already attempted immutable admitted work. Replacing its
  // trigger can invalidate that authority and make an old capped deadline
  // consume fresh input without a reply. Only never-attempted queued work
  // remains mutable; later input receives its own normally admitted job.
  const existing = await tx<
    { id: string; trigger_id: string }[]
  >`SELECT id,payload->>'triggerMessageId' trigger_id FROM ops.jobs WHERE tenant_id=platform.current_tenant_id() AND job_type='whatsapp.ai.reply' AND reference_id=${input.conversationId}::uuid AND status='queued' AND attempts=0 AND admitted_agent_version_id IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE`;
  if (existing[0]) {
    if (existing[0].trigger_id === input.messageId)
      return { handled: true, jobId: existing[0].id };
    const order = await tx<
      { newer: boolean }[]
    >`SELECT incoming.receipt_sequence>previous.receipt_sequence newer
      FROM ops.inbound_events incoming JOIN messaging.messages old ON old.id=${existing[0].trigger_id}::uuid AND old.tenant_id=incoming.tenant_id
      JOIN ops.inbound_events previous ON previous.tenant_id=old.tenant_id AND previous.provider=incoming.provider AND previous.provider_account_id=incoming.provider_account_id AND previous.payload->>'providerMessageId'=old.provider_message_id
      WHERE incoming.id=${input.eventId}::uuid AND incoming.tenant_id=platform.current_tenant_id()`;
    if (order[0]?.newer === false)
      return { handled: true, jobId: existing[0].id };
    await tx`UPDATE ops.jobs SET payload=jsonb_build_object('conversationId',${input.conversationId}::uuid,'triggerMessageId',${input.messageId}::uuid),
      available_at=LEAST(clock_timestamp()+interval '2.5 seconds',created_at+interval '10 seconds'),priority=${priority},updated_at=clock_timestamp()
      WHERE id=${existing[0].id}::uuid AND tenant_id=platform.current_tenant_id()`;
    return { handled: true, jobId: existing[0].id };
  }
  const jobs = await tx<
    { id: string }[]
  >`INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority,available_at)
    VALUES(platform.current_tenant_id(),'messaging','whatsapp.ai.reply','conversation',${input.conversationId}::uuid,
      jsonb_build_object('conversationId',${input.conversationId}::uuid,'triggerMessageId',${input.messageId}::uuid),${"whatsapp-ai:" + input.eventId},3,${priority},clock_timestamp()+interval '2.5 seconds')
    ON CONFLICT DO NOTHING RETURNING id`;
  return { handled: true, ...(jobs[0] ? { jobId: jobs[0].id } : {}) };
}

/** Exhausted envelopes remain durable and get an operator-visible alert record. */
export async function requireNoNewerPendingInbound(
  tx: postgres.TransactionSql,
  conversationId: string,
  triggerId: string,
): Promise<void> {
  await tx`SELECT ops.surface_exhausted_inbound()`;
  const newer = await tx<{ id: string }[]>`SELECT n.id FROM messaging.messages m
    JOIN messaging.conversations c ON c.id=m.conversation_id AND c.tenant_id=m.tenant_id
    JOIN messaging.channels ch ON ch.id=c.channel_id AND ch.tenant_id=c.tenant_id
    JOIN messaging.inbound_message_origins o ON o.message_id=m.id AND o.tenant_id=m.tenant_id
    JOIN ops.inbound_events e ON e.tenant_id=m.tenant_id AND e.provider='meta' AND e.provider_account_id=ch.provider_account_id AND e.payload->>'providerMessageId'=m.provider_message_id
    JOIN ops.inbound_events n ON n.tenant_id=e.tenant_id AND n.provider=e.provider AND n.provider_account_id=e.provider_account_id AND n.receipt_sequence>e.receipt_sequence
      AND n.status IN ('received','processing','failed') AND (n.status='processing' OR n.attempts<n.max_attempts)
      AND n.event_type IN ('whatsapp.message.text','whatsapp.message.image','whatsapp.message.document','whatsapp.message.location','whatsapp.message.audio','whatsapp.message.video','whatsapp.message.interactive')
      AND n.payload->>'providerMessageId'<>m.provider_message_id AND regexp_replace(n.payload->>'from','[^0-9]','','g')=regexp_replace(o.sender_address,'[^0-9]','','g')
    WHERE m.id=${triggerId}::uuid AND c.id=${conversationId}::uuid AND m.tenant_id=platform.current_tenant_id() LIMIT 1`;
  if (newer.length) throw new TypeError("AI inbound trigger superseded");
}
