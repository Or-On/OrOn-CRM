import postgres, { type Sql } from "postgres";

import {
  deliverSimulatorBroadcastRecipient,
  deliverSimulatedCallFollowup,
  ingestWhatsAppInbound,
  ingestWhatsAppStatus,
  parseStoredWhatsAppEnvelope,
  parseStoredWhatsAppStatusEnvelope,
} from "@or-on/crm";

import type { WhatsAppProvider, WhatsAppSendRequest } from "./providers.js";
import { WhatsAppProviderError } from "./providers.js";

interface InboundEventRow {
  id: string;
  tenant_id: string;
  payload: unknown;
  event_type: string;
}

interface JobRow {
  id: string;
  tenant_id: string;
  job_type: string;
  reference_id: string | null;
  payload: unknown;
}

interface OutboundWork {
  readonly delivery: WhatsAppSendRequest["delivery"];
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly provider: "simulator" | "meta";
  readonly recipient: string;
  readonly requestId: string;
  readonly tenantId: string;
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
      if (event.event_type === "whatsapp.message.status") {
        const envelope = parseStoredWhatsAppStatusEnvelope(event.payload);
        if (envelope === undefined)
          throw new TypeError("invalid status envelope");
        await ingestWhatsAppStatus(transaction, envelope);
      } else {
        const envelope = parseStoredWhatsAppEnvelope(event.payload);
        if (envelope === undefined)
          throw new TypeError("invalid inbound envelope");
        await ingestWhatsAppInbound(transaction, envelope);
      }
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
  providers: Readonly<Record<"simulator" | "meta", WhatsAppProvider>>,
): Promise<void> {
  if (job.job_type === "whatsapp.outbound.send" && job.reference_id !== null) {
    await processWhatsAppOutbound(sql, workerId, job, providers);
    return;
  }
  try {
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      const owned = await transaction<{ id: string }[]>`
        SELECT id FROM ops.jobs WHERE id = ${job.id}::uuid
          AND status = 'running' AND locked_by = ${workerId}
          AND locked_at > CURRENT_TIMESTAMP - INTERVAL '60 seconds'
        FOR UPDATE
      `;
      if (owned[0] === undefined) return;
      if (job.job_type === "cross_channel.whatsapp_followup.simulated") {
        await deliverSimulatedCallFollowup(
          transaction,
          job.id,
          job.reference_id,
          job.payload,
        );
      } else if (
        job.job_type === "simulator.broadcast.recipient" &&
        job.reference_id !== null
      ) {
        await deliverSimulatorBroadcastRecipient(transaction, job.reference_id);
      } else {
        throw new TypeError("unsupported messaging job");
      }
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
      if (error instanceof TypeError) {
        await transaction`
          UPDATE ops.jobs SET max_attempts = attempts
          WHERE id = ${job.id}::uuid AND status = 'running' AND locked_by = ${workerId}
        `;
      }
      await transaction`
        SELECT ops.fail_job(${job.id}::uuid, ${workerId}, ${reason}, 5)
      `;
    });
  }
}

async function loadOutboundWork(sql: Sql, job: JobRow): Promise<OutboundWork> {
  return sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    const rows = await transaction<
      {
        content_text: string | null;
        idempotency_key: string;
        message_id: string;
        message_kind: "text" | "template";
        normalized_value: string;
        parameters: unknown;
        provider: "simulator" | "meta";
        request_id: string;
        template_language: string | null;
        template_name: string | null;
      }[]
    >`
      UPDATE messaging.outbound_requests request
      SET status = 'sending', attempted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      FROM messaging.messages message, crm.contact_channel_identities identity
      WHERE request.id = ${job.reference_id}::uuid
        AND request.tenant_id = platform.current_tenant_id()
        AND request.message_id = message.id
        AND request.recipient_identity_id = identity.id
        AND request.status IN ('queued', 'sending')
      RETURNING request.id AS request_id, request.message_id, request.provider,
                request.message_kind, request.idempotency_key, request.template_name,
                request.template_language, request.template_parameters AS parameters,
                message.content_text, identity.normalized_value
    `;
    const row = rows[0];
    if (row === undefined)
      throw new TypeError("outbound request is unavailable");
    const delivery: WhatsAppSendRequest["delivery"] =
      row.message_kind === "text"
        ? { kind: "text", text: row.content_text ?? "" }
        : {
            kind: "template",
            templateName: row.template_name ?? "",
            language: row.template_language ?? "",
            parameters: Array.isArray(row.parameters)
              ? row.parameters.filter(
                  (value): value is string => typeof value === "string",
                )
              : [],
          };
    return {
      requestId: row.request_id,
      messageId: row.message_id,
      provider: row.provider,
      recipient: row.normalized_value,
      idempotencyKey: row.idempotency_key,
      delivery,
      tenantId: job.tenant_id,
    };
  });
}

async function processWhatsAppOutbound(
  sql: Sql,
  workerId: string,
  job: JobRow,
  providers: Readonly<Record<"simulator" | "meta", WhatsAppProvider>>,
): Promise<void> {
  let work: OutboundWork | undefined;
  try {
    work = await loadOutboundWork(sql, job);
    const outboundWork = work;
    const providerName = outboundWork.provider;

    // The external request intentionally runs outside every PostgreSQL transaction.
    const result = await providers[providerName].send({
      recipient: outboundWork.recipient,
      idempotencyKey: outboundWork.idempotencyKey,
      delivery: outboundWork.delivery,
    });
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, outboundWork.tenantId);
      const status = providerName === "simulator" ? "delivered" : "sent";
      await transaction`
        UPDATE messaging.outbound_requests
        SET status = ${status}, provider_message_id = ${result.messageId},
            completed_at = CASE WHEN ${status} = 'delivered' THEN CURRENT_TIMESTAMP ELSE NULL END,
            last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${outboundWork.requestId}::uuid
      `;
      await transaction`
        UPDATE messaging.messages
        SET status = ${status}, provider_message_id = ${result.messageId}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${outboundWork.messageId}::uuid
      `;
      await transaction`
        INSERT INTO messaging.message_delivery_events
          (tenant_id, message_id, provider_event_id, status, occurred_at)
        VALUES (platform.current_tenant_id(), ${outboundWork.messageId}::uuid,
                ${`${providerName}_accepted_${result.messageId}`}, ${status}, CURRENT_TIMESTAMP)
        ON CONFLICT (tenant_id, provider_event_id) WHERE provider_event_id IS NOT NULL
        DO NOTHING
      `;
      await transaction`
        UPDATE messaging.conversations conversation
        SET last_message_at = message.created_at,
            last_message_preview = CASE WHEN message.content_type = 'text' THEN message.content_text ELSE '[template]' END,
            updated_at = CURRENT_TIMESTAMP
        FROM messaging.messages message
        WHERE message.id = ${outboundWork.messageId}::uuid AND conversation.id = message.conversation_id
      `;
      await transaction`
        UPDATE ops.jobs SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP,
          locked_at = NULL, locked_by = NULL, last_error_safe = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${job.id}::uuid AND status = 'running' AND locked_by = ${workerId}
      `;
    });
  } catch (error) {
    const retryable = error instanceof WhatsAppProviderError && error.retryable;
    const code =
      error instanceof WhatsAppProviderError
        ? error.code
        : "outbound_processing_failed";
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (!retryable) {
        await transaction`
          UPDATE ops.jobs SET max_attempts = attempts WHERE id = ${job.id}::uuid
        `;
      }
      await transaction`
        SELECT ops.fail_job(${job.id}::uuid, ${workerId}, ${code}, 5)
      `;
      if (work !== undefined) {
        await transaction`
          UPDATE messaging.outbound_requests request
          SET status = CASE
                WHEN (SELECT status FROM ops.jobs WHERE id = ${job.id}::uuid) = 'dead'
                  THEN 'failed' ELSE 'queued' END,
              last_error_code = ${code}, updated_at = CURRENT_TIMESTAMP,
              completed_at = CASE
                WHEN (SELECT status FROM ops.jobs WHERE id = ${job.id}::uuid) = 'dead'
                  THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE request.id = ${work.requestId}::uuid
        `;
        await transaction`
          UPDATE messaging.messages SET status = CASE
            WHEN (SELECT status FROM ops.jobs WHERE id = ${job.id}::uuid) = 'dead'
              THEN 'failed' ELSE 'queued' END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ${work.messageId}::uuid
        `;
      }
    });
  }
}

export function createMessagingStore(
  databaseUrl: string,
  workerId: string,
  providers: Readonly<Record<"simulator" | "meta", WhatsAppProvider>>,
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
        SELECT id, tenant_id, event_type, payload
        FROM ops.claim_inbound_events(${workerId}, 10, 60)
      `;
      for (const event of events) await processInbound(sql, workerId, event);

      const jobs = await sql<JobRow[]>`
        SELECT id, tenant_id, job_type, reference_id, payload
        FROM ops.claim_jobs_all_tenants(${workerId}, 'messaging', 25, 60)
      `;
      for (const job of jobs) await processJob(sql, workerId, job, providers);
      return events.length + jobs.length;
    },
  };
}
