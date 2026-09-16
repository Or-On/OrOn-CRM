import type postgres from "postgres";

import type { DashboardMetrics } from "./types.js";

export interface OverviewMetrics {
  readonly contacts: number;
  readonly openConversations: number;
  readonly pendingHandoffs: number;
}

export interface OverviewInsights {
  readonly dailyMessages: readonly {
    readonly day: string;
    readonly inbound: number;
    readonly outbound: number;
    readonly delivered?: number;
    readonly failed?: number;
  }[];
  readonly conversationStates: readonly {
    readonly status: string;
    readonly count: number;
  }[];
}

/** Fixed 14 UTC calendar days, over retained tenant-visible records (not a capped list). */
export async function overviewInsights(
  sql: postgres.TransactionSql,
): Promise<OverviewInsights> {
  const dailyMessages = await sql<
    {
      day: string;
      inbound: number;
      outbound: number;
      delivered: number;
      failed: number;
    }[]
  >`
    WITH days AS (
      SELECT generate_series(
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 13,
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,
        interval '1 day'
      )::date AS day
    ), counts AS (
      SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
        count(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
        count(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
        count(*) FILTER (WHERE direction = 'outbound' AND status IN ('delivered', 'read'))::int AS delivered,
        count(*) FILTER (WHERE direction = 'outbound' AND status = 'failed')::int AS failed
      FROM messaging.messages
      WHERE created_at >= (((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 13)::timestamp AT TIME ZONE 'UTC')
        AND created_at <= statement_timestamp()
      GROUP BY 1
    )
    SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
      coalesce(counts.inbound, 0)::int AS inbound,
      coalesce(counts.outbound, 0)::int AS outbound,
      coalesce(counts.delivered, 0)::int AS delivered,
      coalesce(counts.failed, 0)::int AS failed
    FROM days LEFT JOIN counts USING (day) ORDER BY days.day
  `;
  const conversationStates = await sql<{ status: string; count: number }[]>`
    SELECT status, count(*)::int AS count
    FROM messaging.conversations
    WHERE removed_from_inbox_at IS NULL
    GROUP BY status
    ORDER BY status
  `;
  return { dailyMessages, conversationStates };
}

export interface TenantOperationalInsights {
  readonly monthStart: string;
  readonly checkedAt: string;
  readonly inbound: number;
  readonly outbound: number;
  readonly delivered: number;
  readonly failed: number;
  readonly awaiting: number;
  readonly contactsReached: number;
  readonly voiceSessions: number;
  readonly voiceActive: number;
  readonly voiceFailed: number;
  readonly agentEvents: number;
  readonly agentTokens: number;
  readonly flowRuns: number;
  readonly flowSucceeded: number;
  readonly flowFailed: number;
  readonly flowActive: number;
}

/** Read-only current-month cohorts. Existing RLS applies to every source table.
 * Delivery buckets describe the latest state of messages created in the month,
 * not when a delivery receipt arrived. No billing allowance or uptime is inferred.
 */
export async function tenantOperationalInsights(
  sql: postgres.TransactionSql,
): Promise<TenantOperationalInsights> {
  const rows = await sql<TenantOperationalInsights[]>`
    WITH period AS (
      SELECT date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start,
        statement_timestamp() AS finish
    ), messages AS (
      SELECT message.direction, message.status, conversation.contact_id
      FROM messaging.messages message
      JOIN messaging.conversations conversation ON conversation.id = message.conversation_id
        AND conversation.tenant_id = message.tenant_id
      CROSS JOIN period
      WHERE message.created_at >= period.start AND message.created_at <= period.finish
    ), messaging_summary AS (
      SELECT count(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
        count(*) FILTER (WHERE direction = 'outbound')::int AS outbound,
        count(*) FILTER (WHERE direction = 'outbound' AND status IN ('delivered', 'read'))::int AS delivered,
        count(*) FILTER (WHERE direction = 'outbound' AND status = 'failed')::int AS failed,
        count(*) FILTER (WHERE direction = 'outbound' AND status NOT IN ('delivered', 'read', 'failed'))::int AS awaiting,
        count(DISTINCT contact_id) FILTER (WHERE direction = 'outbound' AND status IN ('delivered', 'read'))::int AS "contactsReached"
      FROM messages
    ), voice_summary AS (
      SELECT count(session_id)::int AS "voiceSessions",
        count(session_id) FILTER (WHERE status = 'started')::int AS "voiceActive",
        count(session_id) FILTER (WHERE status = 'failed')::int AS "voiceFailed"
      FROM public.sessions CROSS JOIN period
      WHERE created_at >= period.start AND created_at <= period.finish
    ), agent_summary AS (
      SELECT count(*)::int AS "agentEvents",
        coalesce(sum(input_tokens + output_tokens), 0)::float8 AS "agentTokens"
      FROM agents.usage_events CROSS JOIN period
      WHERE occurred_at >= period.start AND occurred_at <= period.finish
    ), flow_summary AS (
      SELECT count(*)::int AS "flowRuns",
        count(*) FILTER (WHERE status = 'succeeded')::int AS "flowSucceeded",
        count(*) FILTER (WHERE status = 'failed')::int AS "flowFailed",
        count(*) FILTER (WHERE status IN ('pending', 'running', 'waiting'))::int AS "flowActive"
      FROM automation.flow_runs CROSS JOIN period
      WHERE created_at >= period.start AND created_at <= period.finish
    )
    SELECT to_char(period.start AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "monthStart",
      to_char(period.finish AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "checkedAt",
      messaging_summary.*, voice_summary.*, agent_summary.*, flow_summary.*
    FROM period CROSS JOIN messaging_summary CROSS JOIN voice_summary
      CROSS JOIN agent_summary CROSS JOIN flow_summary
  `;
  const row = rows[0];
  if (!row) throw new Error("tenant operational insights returned no row");
  return row;
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
      (SELECT count(*)::int FROM messaging.conversations
       WHERE removed_from_inbox_at IS NULL
         AND status IN ('open', 'pending')) AS open_conversations,
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
      (SELECT count(*)::int FROM messaging.conversations
       WHERE removed_from_inbox_at IS NULL
         AND status IN ('open', 'pending')) AS open_conversations,
      (SELECT COALESCE(sum(unread_count), 0)::int FROM messaging.conversations
       WHERE removed_from_inbox_at IS NULL) AS unread_messages,
      (SELECT COALESCE(sum(value), 0)::text FROM crm.deals WHERE status = 'open') AS open_pipeline_value,
      (SELECT count(*)::int FROM messaging.messages WHERE created_at >= date_trunc('day', CURRENT_TIMESTAMP)) AS messages_today
  `;
  const row = rows[0];
  if (row === undefined)
    throw new Error("dashboard metrics query returned no row");
  const pipelineValues = await sql<{ currency: string; value: string }[]>`
    SELECT currency, sum(value)::text AS value
    FROM crm.deals
    WHERE status = 'open'
    GROUP BY currency
    ORDER BY currency
  `;
  return {
    contacts: row.contacts,
    openConversations: row.open_conversations,
    unreadMessages: row.unread_messages,
    openPipelineValue: row.open_pipeline_value,
    openPipelineValues: pipelineValues,
    messagesToday: row.messages_today,
  };
}
