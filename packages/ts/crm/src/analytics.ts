import type postgres from "postgres";

import type { DashboardMetrics } from "./types.js";

export interface OverviewMetrics {
  readonly contacts: number;
  readonly openConversations: number;
  readonly pendingHandoffs: number;
}

/** Counts are over the active tenant's full RLS-visible set, not capped lists. */
export async function overviewMetrics(
  sql: postgres.TransactionSql,
): Promise<OverviewMetrics> {
  const rows = await sql<
    { contacts: number; open_conversations: number; pending_handoffs: number }[]
  >`
    SELECT
      (SELECT count(*)::int FROM crm.contacts WHERE lifecycle_status = 'active') AS contacts,
      (SELECT count(*)::int FROM messaging.conversations WHERE status IN ('open', 'pending')) AS open_conversations,
      (SELECT count(*)::int FROM automation.handoffs WHERE status = 'pending') AS pending_handoffs
  `;
  const row = rows[0];
  if (!row) throw new Error("overview query returned no row");
  return {
    contacts: row.contacts,
    openConversations: row.open_conversations,
    pendingHandoffs: row.pending_handoffs,
  };
}

interface MetricRow {
  contacts: number;
  open_conversations: number;
  unread_messages: number;
  open_pipeline_value: string;
  messages_today: number;
}

export async function dashboardMetrics(
  sql: postgres.TransactionSql,
): Promise<DashboardMetrics> {
  const rows = await sql<MetricRow[]>`
    SELECT
      (SELECT count(*)::int FROM crm.contacts WHERE lifecycle_status = 'active') AS contacts,
      (SELECT count(*)::int FROM messaging.conversations WHERE status IN ('open', 'pending')) AS open_conversations,
      (SELECT COALESCE(sum(unread_count), 0)::int FROM messaging.conversations) AS unread_messages,
      (SELECT COALESCE(sum(value), 0)::text FROM crm.deals WHERE status = 'open') AS open_pipeline_value,
      (SELECT count(*)::int FROM messaging.messages WHERE created_at >= date_trunc('day', CURRENT_TIMESTAMP)) AS messages_today
  `;
  const row = rows[0];
  if (row === undefined)
    throw new Error("dashboard metrics query returned no row");
  return {
    contacts: row.contacts,
    openConversations: row.open_conversations,
    unreadMessages: row.unread_messages,
    openPipelineValue: row.open_pipeline_value,
    messagesToday: row.messages_today,
  };
}
