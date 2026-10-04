import type { Sql } from "postgres";

export type MonitoringKind =
  "inbound_age" | "dead_reply_job" | "webhook" | "worker" | "backup";
export interface OperatorMonitoringIntent {
  key: string;
  kind: MonitoringKind;
  tenantId?: string;
  resourceId?: string;
  observedAt: string;
  reason: string;
}
export interface HealthObservation {
  healthy: boolean;
  observedAt: Date;
}
export interface MonitoringPorts {
  webhook?: () => Promise<HealthObservation>;
  worker?: () => Promise<HealthObservation>;
  backup?: () => Promise<HealthObservation>;
}
export interface MonitoringResult {
  intents: OperatorMonitoringIntent[];
  unavailable: MonitoringKind[];
}

/** Server-owned cross-tenant monitoring role only; never accept a client tenant filter.
 * Uses existing ops tables. Produces intents, and performs no notification writes.
 */
export async function probeRemediationHealth(
  sql: Sql,
  ports: MonitoringPorts,
  now = new Date(),
): Promise<MonitoringResult> {
  const intents: OperatorMonitoringIntent[] = [];
  const unavailable: MonitoringKind[] = [];
  const observedAt = now.toISOString();
  await sql.begin(async (tx) => {
    await tx`set transaction read only`;
    await tx`set local statement_timeout = '5s'`;
    const inbound = await tx<{ id: string; tenant_id: string }[]>`
      select id, tenant_id from ops.inbound_events
      where status in ('pending', 'running')
        and received_at < ${now}::timestamptz - interval '60 seconds'
      order by received_at, id limit 1000
    `;
    for (const row of inbound) {
      intents.push({
        key: `inbound_age:${row.tenant_id}:${row.id}`,
        kind: "inbound_age",
        tenantId: row.tenant_id,
        resourceId: row.id,
        observedAt,
        reason: "Inbound processing age exceeded 60 seconds",
      });
    }
    const jobs = await tx<{ id: string; tenant_id: string }[]>`
      select id, tenant_id from ops.jobs
      where status = 'dead' and job_type in ('whatsapp.ai.reply', 'whatsapp.outbound.send')
      order by created_at, id limit 1000
    `;
    for (const row of jobs) {
      intents.push({
        key: `dead_reply_job:${row.tenant_id}:${row.id}`,
        kind: "dead_reply_job",
        tenantId: row.tenant_id,
        resourceId: row.id,
        observedAt,
        reason: "WhatsApp reply or send job exhausted retries",
      });
    }
  });
  for (const kind of ["webhook", "worker", "backup"] as const) {
    const port = ports[kind];
    if (!port) {
      unavailable.push(kind);
      continue;
    }
    try {
      const result = await port();
      if (
        !Number.isFinite(result.observedAt.getTime()) ||
        result.observedAt > now
      ) {
        unavailable.push(kind);
      } else if (
        !result.healthy ||
        now.getTime() - result.observedAt.getTime() > 60_000
      ) {
        intents.push({
          key: `health:${kind}`,
          kind,
          observedAt,
          reason: `${kind} health failed or observation exceeded 60 seconds`,
        });
      }
    } catch {
      unavailable.push(kind);
    }
  }
  return {
    intents: [
      ...new Map(intents.map((intent) => [intent.key, intent])).values(),
    ],
    unavailable,
  };
}

/** Caller persists acknowledged keys only after successful delivery. A failed send
 * must not mark a key delivered; recovery should acknowledge and rearm health keys.
 */
export function undeliveredMonitoringIntents(
  intents: readonly OperatorMonitoringIntent[],
  deliveredKeys: ReadonlySet<string>,
): OperatorMonitoringIntent[] {
  return [
    ...new Map(
      intents
        .filter((item) => !deliveredKeys.has(item.key))
        .map((item) => [item.key, item]),
    ).values(),
  ];
}
