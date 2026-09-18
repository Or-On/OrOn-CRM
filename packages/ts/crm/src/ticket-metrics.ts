/**
 * What the AI actually resolved, counted from durable ticket outcomes.
 *
 * Not from model confidence, and not from "the call completed". A ticket counts
 * as an AI-only resolution when the database says it was resolved, says who
 * confirmed it, and shows no human ever took it over. Every one of those three
 * is a column an operator can go and look at.
 *
 * The exclusions are narrow and named: duplicates and cancellations leave the
 * denominator because they were never support outcomes, and nothing else does.
 * An issue that went badly stays in the denominator — removing hard cases to
 * improve the number is the failure mode this module exists to prevent.
 *
 * Reopenings are reported rather than netted off. A ticket resolved and
 * reopened three days later was still resolved on the day, and hiding that
 * rewrites history; showing both lets the reader decide what the pair means.
 */
import type postgres from "postgres";

export const TICKET_METRIC_POLICY_VERSION = "1.0";

export interface TicketOutcomeWindow {
  /** Inclusive lower bound on `opened_at`. */
  readonly since: string;
  /** Exclusive upper bound on `opened_at`. */
  readonly until: string;
  /**
   * How long after a resolution a reopening still counts against it. Reported
   * separately, never subtracted, so the resolution figure stays reproducible.
   */
  readonly reopenWindowDays: number;
}

export interface TicketOutcomeMetrics {
  readonly policyVersion: typeof TICKET_METRIC_POLICY_VERSION;
  readonly window: TicketOutcomeWindow;
  /** Denominator: AI-handled tickets in the window, minus named exclusions. */
  readonly eligible: number;
  readonly excludedDuplicates: number;
  readonly excludedCancelled: number;
  readonly aiOnlyResolved: number;
  readonly aiAssistedResolved: number;
  readonly humanEscalated: number;
  readonly awaitingConfirmation: number;
  readonly openUnresolved: number;
  readonly reopenedAfterResolution: number;
  readonly customerConfirmed: number;
  readonly medianMinutesToResolution: number | null;
  readonly p95MinutesToResolution: number | null;
  readonly callAttempts: number;
  readonly callsWithPlayableRecording: number;
  readonly callsWithReadySummary: number;
}

interface MetricRow {
  eligible: number;
  excluded_duplicates: number;
  excluded_cancelled: number;
  ai_only_resolved: number;
  ai_assisted_resolved: number;
  human_escalated: number;
  awaiting_confirmation: number;
  open_unresolved: number;
  reopened_after_resolution: number;
  customer_confirmed: number;
  median_minutes: string | number | null;
  p95_minutes: string | number | null;
  call_attempts: number;
  calls_with_recording: number;
  calls_with_summary: number;
}

function minutes(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : null;
}

function instant(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value)))
    throw new TypeError(`${name} must be an instant`);
  return value;
}

/**
 * One reporting window's outcomes.
 *
 * Everything is derived in a single statement over the tickets opened in the
 * window, so the counts cannot disagree with each other the way separate
 * queries against a moving queue can. `handling_mode` is the present owner, and
 * an `assignment` event to a person is the durable record that one ever took
 * over — a ticket the AI resolved and a human later reassigned is still not an
 * AI-only resolution.
 */
export async function summarizeTicketOutcomes(
  sql: postgres.TransactionSql,
  window: {
    readonly since: string;
    readonly until: string;
    readonly reopenWindowDays?: number;
  },
): Promise<TicketOutcomeMetrics> {
  const since = instant(window.since, "metric window start");
  const until = instant(window.until, "metric window end");
  if (Date.parse(since) >= Date.parse(until))
    throw new TypeError("metric window start must precede its end");
  const reopenWindowDays = Math.min(
    Math.max(Math.trunc(window.reopenWindowDays ?? 7), 1),
    90,
  );
  const rows = await sql<MetricRow[]>`
    WITH scoped AS (
      SELECT ticket.id, ticket.status, ticket.stage, ticket.handling_mode,
             ticket.closure_reason, ticket.resolution_classification,
             ticket.resolution_confirmed_by, ticket.opened_at, ticket.closed_at,
             EXISTS (
               SELECT 1 FROM support.ticket_events event
               WHERE event.tenant_id = ticket.tenant_id
                 AND event.ticket_id = ticket.id
                 AND event.kind IN ('escalation','assignment')
                 AND event.actor_kind IN ('human','ai')
                 AND event.evidence ->> 'handlingMode' = 'human'
             ) AS human_took_over,
             EXISTS (
               SELECT 1 FROM support.ticket_events event
               WHERE event.tenant_id = ticket.tenant_id
                 AND event.ticket_id = ticket.id AND event.kind = 'reopened'
                 AND event.occurred_at <= ticket.opened_at
                   + make_interval(days => ${reopenWindowDays})
             ) AS reopened_in_window
      FROM support.tickets ticket
      WHERE ticket.tenant_id = platform.current_tenant_id()
        AND ticket.opened_at >= ${since}::timestamptz
        AND ticket.opened_at < ${until}::timestamptz
        -- A ticket no automatic channel ever handled is somebody else's number.
        AND (ticket.source_channel IN ('whatsapp','voice')
             OR ticket.handling_mode IN ('ai_whatsapp','ai_voice'))
    ), eligible AS (
      SELECT * FROM scoped
      WHERE closure_reason IS DISTINCT FROM 'duplicate'
        AND closure_reason IS DISTINCT FROM 'cancelled'
    ), durations AS (
      SELECT extract(epoch FROM (closed_at - opened_at)) / 60.0 AS resolved_minutes
      FROM eligible
      WHERE closed_at IS NOT NULL AND resolution_classification = 'resolved'
    )
    SELECT
      (SELECT count(*)::int FROM eligible) AS eligible,
      (SELECT count(*)::int FROM scoped WHERE closure_reason = 'duplicate')
        AS excluded_duplicates,
      (SELECT count(*)::int FROM scoped WHERE closure_reason = 'cancelled')
        AS excluded_cancelled,
      (SELECT count(*)::int FROM eligible
       WHERE resolution_classification = 'resolved'
         AND resolution_confirmed_by <> 'none' AND NOT human_took_over)
        AS ai_only_resolved,
      (SELECT count(*)::int FROM eligible
       WHERE resolution_classification = 'resolved'
         AND resolution_confirmed_by <> 'none' AND human_took_over)
        AS ai_assisted_resolved,
      (SELECT count(*)::int FROM eligible WHERE human_took_over) AS human_escalated,
      (SELECT count(*)::int FROM eligible
       WHERE status = 'open'
         AND resolution_classification = 'proposed_fix_awaiting_confirmation')
        AS awaiting_confirmation,
      (SELECT count(*)::int FROM eligible
       WHERE status = 'open'
         AND resolution_classification IN ('unknown','unresolved'))
        AS open_unresolved,
      (SELECT count(*)::int FROM eligible WHERE reopened_in_window)
        AS reopened_after_resolution,
      (SELECT count(*)::int FROM eligible WHERE resolution_confirmed_by = 'customer')
        AS customer_confirmed,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY resolved_minutes)
       FROM durations) AS median_minutes,
      (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY resolved_minutes)
       FROM durations) AS p95_minutes,
      (SELECT count(*)::int FROM support.ticket_call_attempts attempt
       JOIN eligible ON eligible.id = attempt.ticket_id
       WHERE attempt.tenant_id = platform.current_tenant_id()) AS call_attempts,
      (SELECT count(*)::int FROM support.ticket_call_attempts attempt
       JOIN eligible ON eligible.id = attempt.ticket_id
       WHERE attempt.tenant_id = platform.current_tenant_id()
         AND attempt.recording_state IN ('ready','partial')) AS calls_with_recording,
      (SELECT count(*)::int FROM support.ticket_call_attempts attempt
       JOIN eligible ON eligible.id = attempt.ticket_id
       WHERE attempt.tenant_id = platform.current_tenant_id()
         AND attempt.summary_state = 'ready') AS calls_with_summary
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("ticket outcome summary failed");
  return {
    policyVersion: TICKET_METRIC_POLICY_VERSION,
    window: { since, until, reopenWindowDays },
    eligible: row.eligible,
    excludedDuplicates: row.excluded_duplicates,
    excludedCancelled: row.excluded_cancelled,
    aiOnlyResolved: row.ai_only_resolved,
    aiAssistedResolved: row.ai_assisted_resolved,
    humanEscalated: row.human_escalated,
    awaitingConfirmation: row.awaiting_confirmation,
    openUnresolved: row.open_unresolved,
    reopenedAfterResolution: row.reopened_after_resolution,
    customerConfirmed: row.customer_confirmed,
    medianMinutesToResolution: minutes(row.median_minutes),
    p95MinutesToResolution: minutes(row.p95_minutes),
    callAttempts: row.call_attempts,
    callsWithPlayableRecording: row.calls_with_recording,
    callsWithReadySummary: row.calls_with_summary,
  };
}

/**
 * The headline rate, with the denominator it was computed from.
 *
 * Returns `null` rather than zero for an empty window: "0%" and "no tickets
 * yet" mean opposite things and a dashboard that renders them the same way is
 * lying about one of them.
 */
export function confirmedAiOnlyResolutionRate(metrics: TicketOutcomeMetrics): {
  readonly rate: number;
  readonly numerator: number;
  readonly denominator: number;
} | null {
  if (metrics.eligible === 0) return null;
  return {
    rate: metrics.aiOnlyResolved / metrics.eligible,
    numerator: metrics.aiOnlyResolved,
    denominator: metrics.eligible,
  };
}
