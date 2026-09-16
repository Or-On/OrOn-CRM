import { createHash } from "node:crypto";

import type postgres from "postgres";

import type { BroadcastSummary } from "./types.js";

interface BroadcastRow {
  id: string;
  name: string;
  status: BroadcastSummary["status"];
  total_recipients: number;
  delivered_count: number;
  failed_count: number;
  created_at: Date;
}

function mapBroadcast(row: BroadcastRow): BroadcastSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    totalRecipients: row.total_recipients,
    deliveredCount: row.delivered_count,
    failedCount: row.failed_count,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listBroadcasts(
  sql: postgres.TransactionSql,
): Promise<readonly BroadcastSummary[]> {
  const rows = await sql<BroadcastRow[]>`
    SELECT broadcast.id, campaign.name, broadcast.status,
           broadcast.total_recipients, broadcast.delivered_count,
           broadcast.failed_count, broadcast.created_at
    FROM messaging.broadcasts broadcast
    JOIN platform.campaigns campaign ON campaign.id = broadcast.campaign_id
    ORDER BY broadcast.created_at DESC, broadcast.id DESC
  `;
  return rows.map(mapBroadcast);
}

export async function createSimulatorBroadcast(
  sql: postgres.TransactionSql,
  actorUserId: string,
  name: string,
  body: string,
): Promise<string> {
  const normalizedName = name.trim();
  const normalizedBody = body.trim();
  if (!normalizedName || !normalizedBody)
    throw new TypeError("campaign name and message are required");
  const channels = await sql<{ id: string }[]>`
    SELECT id FROM messaging.channels
    WHERE tenant_id = platform.current_tenant_id()
      AND provider = 'simulator'
    ORDER BY created_at
    LIMIT 1
  `;
  const channelId = channels[0]?.id;
  if (channelId === undefined)
    throw new Error("WhatsApp simulator channel is unavailable");
  const campaigns = await sql<{ id: string }[]>`
    INSERT INTO platform.campaigns
      (tenant_id, name, status, channel, created_by_user_id)
    VALUES (platform.current_tenant_id(), ${normalizedName}, 'draft', 'whatsapp', ${actorUserId}::uuid)
    RETURNING id
  `;
  const campaignId = campaigns[0]?.id;
  if (campaignId === undefined)
    throw new Error("campaign insert returned no identifier");
  const templates = await sql<{ id: string }[]>`
    INSERT INTO messaging.message_templates
      (tenant_id, channel_id, name, language, category, status, body)
    VALUES (platform.current_tenant_id(), ${channelId}::uuid,
            ${`sim-${campaignId}`}, 'en', 'MARKETING', 'approved', ${normalizedBody})
    RETURNING id
  `;
  const templateId = templates[0]?.id;
  if (templateId === undefined)
    throw new Error("template insert returned no identifier");
  const broadcasts = await sql<{ id: string }[]>`
    INSERT INTO messaging.broadcasts
      (tenant_id, campaign_id, channel_id, template_id, status)
    VALUES (platform.current_tenant_id(), ${campaignId}::uuid, ${channelId}::uuid,
            ${templateId}::uuid, 'draft') RETURNING id
  `;
  const broadcastId = broadcasts[0]?.id;
  if (broadcastId === undefined)
    throw new Error("broadcast insert returned no identifier");
  await sql`
    INSERT INTO messaging.broadcast_recipients
      (tenant_id, broadcast_id, contact_id, template_params)
    SELECT platform.current_tenant_id(), ${broadcastId}::uuid, contact.id, '[]'::jsonb
    FROM crm.contacts contact
    WHERE contact.tenant_id = platform.current_tenant_id()
      AND contact.lifecycle_status = 'active'
      AND EXISTS (SELECT 1 FROM crm.contact_channel_identities identity
                  WHERE identity.tenant_id = platform.current_tenant_id()
                    AND identity.contact_id = contact.id
                    AND identity.channel = 'whatsapp')
    ON CONFLICT DO NOTHING
  `;
  await sql`
    UPDATE messaging.broadcasts broadcast
    SET total_recipients = (
      SELECT count(*)::integer FROM messaging.broadcast_recipients recipient
      WHERE recipient.broadcast_id = broadcast.id
    ), updated_at = CURRENT_TIMESTAMP
    WHERE broadcast.id = ${broadcastId}::uuid
  `;
  return broadcastId;
}

export async function deliverSimulatorBroadcast(
  sql: postgres.TransactionSql,
  broadcastId: string,
): Promise<number> {
  const recipients = await sql<{ id: string }[]>`
    UPDATE messaging.broadcast_recipients
    SET status = 'delivered', attempts = attempts + 1,
        sent_at = CURRENT_TIMESTAMP, delivered_at = CURRENT_TIMESTAMP,
        provider_message_id = 'sim_broadcast_' || replace(id::text, '-', '')
    WHERE broadcast_id = ${broadcastId}::uuid AND status IN ('pending', 'failed')
    RETURNING id
  `;
  await sql`
    UPDATE messaging.broadcasts SET status = 'sent', updated_at = CURRENT_TIMESTAMP
    WHERE id = ${broadcastId}::uuid
  `;
  return recipients.length;
}

export async function enqueueSimulatorBroadcast(
  sql: postgres.TransactionSql,
  broadcastId: string,
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ops.jobs
      (tenant_id, queue, job_type, reference_type, reference_id, payload,
       idempotency_key, max_attempts)
    SELECT recipient.tenant_id, 'messaging', 'simulator.broadcast.recipient',
           'broadcast_recipient', recipient.id,
           jsonb_build_object('broadcastId', recipient.broadcast_id,
                              'recipientId', recipient.id),
           'broadcast-recipient:' || recipient.id::text, 5
    FROM messaging.broadcast_recipients recipient
    JOIN messaging.broadcasts broadcast ON broadcast.id = recipient.broadcast_id
    JOIN messaging.channels channel ON channel.id = broadcast.channel_id
    WHERE recipient.broadcast_id = ${broadcastId}::uuid
      AND recipient.status IN ('pending', 'failed')
      AND channel.provider = 'simulator'
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  await sql`
    UPDATE messaging.broadcasts
    SET status = CASE WHEN total_recipients = 0 THEN 'sent' ELSE 'scheduled' END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${broadcastId}::uuid AND status IN ('draft', 'paused', 'failed')
  `;
  return rows.length;
}

export async function deliverSimulatorBroadcastRecipient(
  sql: postgres.TransactionSql,
  recipientId: string,
): Promise<boolean> {
  const digest = createHash("sha256").update(recipientId).digest("hex");
  const rows = await sql<{ broadcast_id: string }[]>`
    UPDATE messaging.broadcast_recipients recipient
    SET status = 'delivered', attempts = attempts + 1,
        sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP),
        delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
        provider_message_id = COALESCE(provider_message_id, ${`sim_broadcast_${digest.slice(0, 24)}`}),
        last_error_safe = NULL
    FROM messaging.broadcasts broadcast, messaging.channels channel
    WHERE recipient.id = ${recipientId}::uuid
      AND broadcast.id = recipient.broadcast_id
      AND channel.id = broadcast.channel_id
      AND channel.provider = 'simulator'
      AND recipient.status IN ('pending', 'failed')
    RETURNING recipient.broadcast_id
  `;
  const broadcastId = rows[0]?.broadcast_id;
  if (broadcastId === undefined) return false;
  await sql`
    UPDATE messaging.broadcasts broadcast SET status = 'sent',
      updated_at = CURRENT_TIMESTAMP
    WHERE broadcast.id = ${broadcastId}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM messaging.broadcast_recipients recipient
        WHERE recipient.broadcast_id = broadcast.id
          AND recipient.status IN ('pending', 'failed')
      )
  `;
  return true;
}

export function broadcastIdempotencyKey(
  broadcastId: string,
  contactId: string,
): string {
  return createHash("sha256")
    .update(`${broadcastId}:${contactId}`)
    .digest("hex");
}
