import postgres, { type Sql } from "postgres";

import {
  deliverSimulatorBroadcastRecipient,
  ingestWhatsAppInbound,
  parseStoredWhatsAppEnvelope,
} from "@or-on/crm";

interface InboundEventRow {
  id: string;
  tenant_id: string;
  payload: unknown;
}

interface JobRow {
  id: string;
  tenant_id: string;
  job_type: string;
  reference_id: string | null;
}

export interface MessagingStore {
  readonly close: () => Promise<void>;
  readonly isReady: () => Promise<boolean>;
  readonly processAvailable: () => Promise<number>;
}

async function setTenantContext(
  transaction: postgres.TransactionSql,
  tenantId: string,
): Promise<void> {
  await transaction`
    SELECT set_config('app.current_tenant', ${tenantId}, true),
           set_config('app.current_role', 'service', true)
  `;
}

async function processInbound(
  sql: Sql,
  workerId: string,
  event: InboundEventRow,
): Promise<void> {
  try {
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, event.tenant_id);
      const envelope = parseStoredWhatsAppEnvelope(event.payload);
      if (envelope === undefined)
        throw new TypeError("invalid inbound envelope");
      await ingestWhatsAppInbound(transaction, envelope);
      await transaction`
        SELECT ops.complete_inbound_event(${event.id}::uuid, ${workerId})
      `;
    });
  } catch (error) {
    const reason =
      error instanceof TypeError ? error.message : "inbound processing failed";
    await sql`
      SELECT ops.fail_inbound_event(${event.id}::uuid, ${workerId}, ${reason}, 5)
    `;
  }
}

async function processJob(
  sql: Sql,
  workerId: string,
  job: JobRow,
): Promise<void> {
  try {
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (
        job.job_type !== "simulator.broadcast.recipient" ||
        job.reference_id === null
      ) {
        throw new TypeError("unsupported messaging job");
      }
      await deliverSimulatorBroadcastRecipient(transaction, job.reference_id);
      await transaction`
        UPDATE ops.jobs SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP,
          locked_at = NULL, locked_by = NULL, last_error_safe = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${job.id}::uuid AND status = 'running' AND locked_by = ${workerId}
      `;
    });
  } catch (error) {
    const reason =
      error instanceof TypeError ? error.message : "messaging job failed";
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await transaction`
        SELECT ops.fail_job(${job.id}::uuid, ${workerId}, ${reason}, 5)
      `;
    });
  }
}

export function createMessagingStore(
  databaseUrl: string,
  workerId: string,
): MessagingStore {
  const sql = postgres(databaseUrl, {
    connect_timeout: 2,
    idle_timeout: 10,
    max: 4,
    prepare: false,
  });
  return {
    async close() {
      await sql.end({ timeout: 2 });
    },
    async isReady() {
      try {
        await sql`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    async processAvailable() {
      const events = await sql<InboundEventRow[]>`
        SELECT id, tenant_id, payload
        FROM ops.claim_inbound_events(${workerId}, 10, 60)
      `;
      for (const event of events) await processInbound(sql, workerId, event);

      const jobs = await sql<JobRow[]>`
        SELECT id, tenant_id, job_type, reference_id
        FROM ops.claim_jobs_all_tenants(${workerId}, 'messaging', 25, 60)
      `;
      for (const job of jobs) await processJob(sql, workerId, job);
      return events.length + jobs.length;
    },
  };
}
