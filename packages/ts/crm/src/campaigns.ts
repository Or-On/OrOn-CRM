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
    SELECT id FROM messaging.channels WHERE provider = 'simulator' ORDER BY created_at LIMIT 1
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
    WHERE contact.lifecycle_status = 'active'
      AND EXISTS (SELECT 1 FROM crm.contact_channel_identities identity
                  WHERE identity.contact_id = contact.id AND identity.channel = 'whatsapp')
    ON CONFLICT DO NOTHING
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

export function broadcastIdempotencyKey(
  broadcastId: string,
  contactId: string,
): string {
  return createHash("sha256")
    .update(`${broadcastId}:${contactId}`)
    .digest("hex");
}
