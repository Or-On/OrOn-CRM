import postgres, { type Sql } from "postgres";

import {
  deliverSimulatorBroadcastRecipient,
  deliverSimulatedCallFollowup,
  advanceCanonicalSimulation,
  ingestWhatsAppInbound,
  ingestWhatsAppStatus,
  parseStoredWhatsAppEnvelope,
  parseStoredWhatsAppStatusEnvelope,
  messageDeliveryFailure,
  loadEligibleAgentKnowledge,
  queueWhatsAppAutomaticCall,
  queueWhatsAppOutbound,
  assignDefaultWhatsAppAi,
  createInboundConversationNotifications,
  type MessageDeliveryFailure,
} from "@or-on/crm";

import type { WhatsAppProvider, WhatsAppSendRequest } from "./providers.js";
import { WhatsAppProviderError } from "./providers.js";
import {
  WhatsAppAiProviderError,
  type WhatsAppAiEscalationReason,
  type WhatsAppAiProvider,
} from "./ai-provider.js";
import {
  AutomaticCallProviderError,
  type AutomaticCallProvider,
  type AutomaticCallRequest,
} from "./call-provider.js";
import {
  actionReceiptReply,
  explicitlyRequestsImmediateCall,
  factDigest,
  groundAiReply,
  type EligibleKnowledgeFact,
  type GroundedReply,
} from "./ai-grounding.js";

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
  readonly senderPhoneNumberId: string | undefined;
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

export interface MessagingAutomationOptions {
  readonly simulatorEnabled?: boolean;
  readonly aiProvider?: WhatsAppAiProvider;
  readonly automaticCallProvider?: AutomaticCallProvider;
  readonly automaticCallsEnabled?: boolean;
  readonly realWhatsAppEnabled?: boolean;
}

const safeEscalationReasons: Readonly<
  Record<WhatsAppAiEscalationReason, string>
> = {
  human_requested: "Customer requested a human operator",
  emergency: "Urgent human review requested",
  safety: "Safety-sensitive request requires human review",
  regulated_decision: "Regulated decision requires human review",
  insufficient_context: "Human review required for unavailable context",
  call_requested: "Customer requested a telephone call",
};

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
  aiEnabled: boolean,
  realWhatsAppEnabled: boolean,
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
        const result = await ingestWhatsAppInbound(transaction, envelope);
        if (result.inserted) {
          await createInboundConversationNotifications(
            transaction,
            result.conversationId,
          );
          if (aiEnabled && realWhatsAppEnabled)
            await assignDefaultWhatsAppAi(transaction, result.conversationId);
          await transaction`
            INSERT INTO ops.jobs
              (tenant_id, queue, job_type, reference_type, reference_id, payload,
               idempotency_key, max_attempts)
            SELECT platform.current_tenant_id(), 'messaging', 'whatsapp.ai.reply',
                   'conversation', ${result.conversationId}::uuid,
                   jsonb_build_object('conversationId', ${result.conversationId}::uuid,
                     'triggerMessageId', (SELECT id FROM messaging.messages
                       WHERE conversation_id=${result.conversationId}::uuid
                         AND provider_message_id=${envelope.providerMessageId}
                         AND direction='inbound' LIMIT 1)),
                   ${`whatsapp-ai:${event.id}`}, 3
            WHERE ${aiEnabled} AND EXISTS (
              SELECT 1 FROM messaging.conversations conversation
              JOIN messaging.channels channel ON channel.id = conversation.channel_id
              WHERE conversation.id = ${result.conversationId}::uuid
                AND conversation.ownership_mode = 'ai'
                AND (channel.provider = 'simulator' OR
                     (channel.provider = 'meta' AND ${realWhatsAppEnabled}))
            )
            ON CONFLICT DO NOTHING
          `;
        }
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
  reportFailure:
    | ((failure: MessageDeliveryFailure & { readonly jobId: string }) => void)
    | undefined,
  automation: MessagingAutomationOptions,
): Promise<void> {
  if (job.job_type === "whatsapp.outbound.send" && job.reference_id !== null) {
    await processWhatsAppOutbound(
      sql,
      workerId,
      job,
      providers,
      reportFailure,
      automation.simulatorEnabled === true,
    );
    return;
  }
  if (job.job_type === "whatsapp.ai.reply" && job.reference_id !== null) {
    await processWhatsAppAiReply(sql, workerId, job, automation);
    return;
  }
  if (job.job_type === "whatsapp.ai.call" && job.reference_id !== null) {
    await processAutomaticCall(sql, workerId, job, automation);
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
      if (automation.simulatorEnabled !== true)
        throw new TypeError("simulation_disabled");
      if (
        job.job_type === "cross_channel.flow.simulated" &&
        job.reference_id !== null
      ) {
        if (JSON.stringify(job.payload) !== '{"mode":"simulator"}')
          throw new TypeError("invalid flow simulator mode");
        const completed = await advanceCanonicalSimulation(
          transaction,
          job.reference_id,
        );
        if (!completed) {
          // Waiting on another durable action is polling, not a failed attempt.
          // A persisted 15-minute run deadline bounds this path.
          await transaction`UPDATE ops.jobs SET status='queued', attempts=GREATEST(0,attempts-1),
            available_at=CURRENT_TIMESTAMP+INTERVAL '2 seconds', locked_at=NULL, locked_by=NULL,
            updated_at=CURRENT_TIMESTAMP WHERE id=${job.id}::uuid AND locked_by=${workerId}`;
          return;
        }
      } else if (job.job_type === "cross_channel.whatsapp_followup.simulated") {
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
      if (
        job.job_type === "cross_channel.flow.simulated" &&
        job.reference_id !== null
      ) {
        await transaction`UPDATE automation.flow_runs SET status='failed', error_safe='simulation_action_failed',
          completed_at=CURRENT_TIMESTAMP WHERE id=${job.reference_id}::uuid
          AND EXISTS(SELECT 1 FROM ops.jobs WHERE id=${job.id}::uuid AND status='dead')`;
        await transaction`UPDATE automation.flow_step_runs SET status='failed',
          error_safe='simulation_action_failed', completed_at=CURRENT_TIMESTAMP
          WHERE flow_run_id=${job.reference_id}::uuid AND status IN ('running','waiting')
          AND EXISTS(SELECT 1 FROM ops.jobs WHERE id=${job.id}::uuid AND status='dead')`;
      }
    });
  }
}

interface AiWork {
  readonly agentVersionId: string;
  readonly knowledge: readonly EligibleKnowledgeFact[];
  readonly ownershipEpoch: string;
  readonly authorizedUserId: string;
  readonly conversationId: string;
  readonly locale: string;
  readonly provider: "simulator" | "meta";
  readonly systemPrompt: string;
  readonly channelConfiguration:
    | {
        readonly graphApiVersion: string;
        readonly phoneNumberId: string;
        readonly wabaId: string;
      }
    | undefined;
  readonly messages: readonly {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly occurredAt: string;
    readonly provenance:
      "caller_report_unverified" | "prior_assistant_unverified";
  }[];
  readonly triggerMessageId: string;
}

async function eligibleFacts(
  transaction: postgres.TransactionSql,
  agentVersionId: string,
): Promise<readonly EligibleKnowledgeFact[]> {
  const documents = await loadEligibleAgentKnowledge(
    transaction,
    agentVersionId,
  );
  return documents.flatMap((document) =>
    document.facts.map((fact) => ({
      sourceId: document.sourceId,
      documentId: document.documentId,
      version: document.version,
      factKey: fact.factKey,
      value: fact.value,
    })),
  );
}

function triggerFromJob(job: JobRow): string {
  const value = job.payload as Readonly<Record<string, unknown>> | null;
  if (
    typeof value?.triggerMessageId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(
      value.triggerMessageId,
    )
  )
    throw new TypeError("AI job has no bound inbound trigger");
  return value.triggerMessageId;
}

async function requireCurrentTrigger(
  transaction: postgres.TransactionSql,
  conversationId: string,
  triggerMessageId: string,
): Promise<void> {
  const latest = await transaction<{ id: string }[]>`
    SELECT id FROM messaging.messages WHERE conversation_id=${conversationId}::uuid
      AND direction='inbound' ORDER BY created_at DESC, id DESC LIMIT 1
  `;
  if (latest[0]?.id !== triggerMessageId)
    throw new TypeError("AI inbound trigger superseded");
}

async function loadAiWork(
  sql: Sql,
  workerId: string,
  job: JobRow,
): Promise<AiWork> {
  return sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job.id);
    const triggerMessageId = triggerFromJob(job);
    const rows = await transaction<
      {
        ai_enabled_by_user_id: string;
        conversation_id: string;
        locale: string;
        provider: "simulator" | "meta";
        system_prompt: string;
        configuration: unknown;
        ownership_epoch: string;
        agent_version_id: string;
      }[]
    >`
      SELECT conversation.id AS conversation_id,
             conversation.ai_enabled_by_user_id,
             agent.system_prompt, agent.locale, agent.id AS agent_version_id, conversation.ownership_epoch,
             channel.provider, channel.configuration
      FROM messaging.conversations conversation
      JOIN agents.agent_profile_versions agent
        ON agent.id = conversation.ai_agent_profile_version_id
       AND agent.tenant_id = conversation.tenant_id
      JOIN messaging.channels channel ON channel.id = conversation.channel_id
      WHERE conversation.id = ${job.reference_id}::uuid
        AND conversation.ownership_mode = 'ai'
        AND agent.published_at IS NOT NULL AND agent.validation_status='valid'
        AND channel.provider IN ('simulator', 'meta')
      FOR UPDATE OF conversation
    `;
    const row = rows[0];
    if (row === undefined)
      throw new TypeError("AI conversation ownership changed");
    await transaction`
      SELECT set_config('app.current_user', ${row.ai_enabled_by_user_id}, true)
    `;
    const authorization = await transaction<{ authorized: boolean }[]>`
      SELECT platform.messaging_ai_actor_authorized(
        ${row.ai_enabled_by_user_id}::uuid
      ) AS authorized
    `;
    if (authorization[0]?.authorized !== true)
      throw new TypeError("AI authorizing operator is no longer active");
    await requireCurrentTrigger(
      transaction,
      row.conversation_id,
      triggerMessageId,
    );
    const knowledge = await eligibleFacts(transaction, row.agent_version_id);
    const history = await transaction<
      {
        id: string;
        direction: "inbound" | "outbound";
        content_text: string;
        created_at: Date;
      }[]
    >`
      SELECT id, direction, content_text, created_at
      FROM messaging.messages
      WHERE conversation_id = ${row.conversation_id}::uuid
        AND content_type = 'text' AND content_text IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT 20
    `;
    const config = row.configuration as Record<string, unknown> | null;
    const channelConfiguration =
      row.provider === "meta" &&
      typeof config?.graphApiVersion === "string" &&
      typeof config.phoneNumberId === "string" &&
      typeof config.wabaId === "string"
        ? {
            graphApiVersion: config.graphApiVersion,
            phoneNumberId: config.phoneNumberId,
            wabaId: config.wabaId,
          }
        : undefined;
    if (!history.some((message) => message.id === triggerMessageId))
      throw new TypeError("AI conversation has no inbound trigger message");
    return {
      agentVersionId: row.agent_version_id,
      knowledge,
      ownershipEpoch: row.ownership_epoch,
      conversationId: row.conversation_id,
      authorizedUserId: row.ai_enabled_by_user_id,
      systemPrompt: row.system_prompt,
      locale: row.locale,
      provider: row.provider,
      channelConfiguration,
      triggerMessageId,
      messages: history.reverse().map((message) => ({
        id: message.id,
        role: message.direction === "inbound" ? "user" : "assistant",
        text: message.content_text.slice(0, 1800),
        occurredAt: message.created_at.toISOString(),
        provenance:
          message.direction === "inbound"
            ? "caller_report_unverified"
            : "prior_assistant_unverified",
      })),
    };
  });
}

async function createAiHandoff(
  transaction: postgres.TransactionSql,
  work: AiWork,
  jobId: string,
  reasonCode: WhatsAppAiEscalationReason,
): Promise<string> {
  const safeReason = safeEscalationReasons[reasonCode];
  const receipt = await transaction<{ id: string }[]>`
    INSERT INTO automation.handoffs
      (tenant_id, contact_id, conversation_id, requested_by_user_id,
       source_channel, reason_safe, status, idempotency_key)
    SELECT conversation.tenant_id, conversation.contact_id, conversation.id,
           ${work.authorizedUserId}::uuid, 'whatsapp', ${safeReason},
           'pending', ${`ai-handoff:${jobId}`}
    FROM messaging.conversations conversation
    WHERE conversation.id=${work.conversationId}::uuid
    ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
      SET idempotency_key=EXCLUDED.idempotency_key
    RETURNING id
  `;
  if (receipt[0] === undefined)
    throw new TypeError("AI handoff was not recorded");
  await transaction`
    UPDATE messaging.conversations
    SET ownership_mode='human', ai_agent_profile_version_id=NULL,
        ai_enabled_by_user_id=NULL, ai_enabled_at=NULL,
        handoff_reason_safe=${safeReason}, updated_at=CURRENT_TIMESTAMP
    WHERE id=${work.conversationId}::uuid
  `;
  await transaction`
    INSERT INTO audit.records
      (tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (platform.current_tenant_id(), ${work.authorizedUserId}::uuid,
            'conversation.ai_handoff', 'conversation', ${work.conversationId}::uuid,
            ${transaction.json({ reasonCode })})
  `;
  return receipt[0].id;
}

async function processWhatsAppAiReply(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
): Promise<void> {
  try {
    if (automation.aiProvider === undefined)
      throw new TypeError("WhatsApp AI is disabled");
    const work = await loadAiWork(sql, workerId, job);
    if (work.provider === "simulator" && automation.simulatorEnabled !== true)
      throw new TypeError("simulation_disabled");
    // Model traffic intentionally runs outside every PostgreSQL transaction.
    const decision = await automation.aiProvider.decide(work);
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job.id);
      await transaction`
        SELECT set_config('app.current_user', ${work.authorizedUserId}, true)
      `;
      const authorization = await transaction<{ authorized: boolean }[]>`
        SELECT platform.messaging_ai_actor_authorized(
          ${work.authorizedUserId}::uuid
        ) AS authorized
      `;
      if (authorization[0]?.authorized !== true)
        throw new TypeError("AI authorizing operator is no longer active");
      const owned = await transaction<{ id: string }[]>`
        SELECT id FROM messaging.conversations
        WHERE id = ${work.conversationId}::uuid AND ownership_mode = 'ai'
          AND ai_enabled_by_user_id = ${work.authorizedUserId}::uuid
          AND ownership_epoch = ${work.ownershipEpoch}::bigint
        FOR UPDATE
      `;
      if (owned[0] === undefined)
        throw new TypeError("AI conversation ownership changed");
      await requireCurrentTrigger(
        transaction,
        work.conversationId,
        work.triggerMessageId,
      );
      const grounded = groundAiReply(
        decision,
        await eligibleFacts(transaction, work.agentVersionId),
        work.locale,
      );
      let responseText = grounded.text;
      let evidence:
        | GroundedReply["evidence"]
        | {
            kind: "receipt";
            operation: "handoff" | "callback";
            resourceId: string;
          } = grounded.evidence;
      let automaticCallQueued = false;
      if (decision.action === "handoff") {
        const resourceId = await createAiHandoff(
          transaction,
          work,
          job.id,
          decision.reasonCode,
        );
        evidence = { kind: "receipt", operation: "handoff", resourceId };
        responseText = actionReceiptReply("handoff", work.locale);
      }
      if (decision.action === "request_call") {
        if (
          automation.automaticCallsEnabled === true &&
          automation.automaticCallProvider !== undefined &&
          explicitlyRequestsImmediateCall(
            work.messages.find(
              (message) => message.id === work.triggerMessageId,
            )?.text ?? "",
          )
        ) {
          try {
            const receipt = await queueWhatsAppAutomaticCall(
              transaction,
              work.authorizedUserId,
              work.conversationId,
              work.triggerMessageId,
              `whatsapp-ai-call:${job.id}`,
            );
            automaticCallQueued = true;
            evidence = {
              kind: "receipt",
              operation: "callback",
              resourceId: receipt.jobId,
            };
            responseText = actionReceiptReply("callback", work.locale);
            await transaction`
              INSERT INTO audit.records
                (tenant_id, actor_user_id, action, target_type, target_id, metadata)
              VALUES (platform.current_tenant_id(), ${work.authorizedUserId}::uuid,
                      'conversation.call_requested', 'conversation',
                      ${work.conversationId}::uuid,
                      ${transaction.json({
                        reasonCode: decision.reasonCode,
                        routing: "automatic",
                      })})
            `;
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            const resourceId = await createAiHandoff(
              transaction,
              work,
              job.id,
              decision.reasonCode,
            );
            evidence = { kind: "receipt", operation: "handoff", resourceId };
            responseText = actionReceiptReply("handoff", work.locale);
          }
        } else {
          const resourceId = await createAiHandoff(
            transaction,
            work,
            job.id,
            decision.reasonCode,
          );
          evidence = { kind: "receipt", operation: "handoff", resourceId };
          responseText = actionReceiptReply("handoff", work.locale);
        }
      }
      if (
        decision.action === "reply" ||
        decision.action === "knowledge" ||
        work.provider === "simulator" ||
        automation.realWhatsAppEnabled === true
      ) {
        const outbound = await queueWhatsAppOutbound(
          transaction,
          {
            conversationId: work.conversationId,
            explicitlyConfirmed: true,
            idempotencyKey: `ai-reply:${job.id}`,
            kind: "text",
            provider: work.provider,
            realProviderEnabled: automation.realWhatsAppEnabled === true,
            senderUserId: work.authorizedUserId,
            senderType: "agent",
            text: responseText,
          },
          work.channelConfiguration,
        );
        await transaction`
          UPDATE messaging.messages SET provider_payload=COALESCE(provider_payload, '{}'::jsonb) ||
            ${transaction.json({
              aiGrounding: {
                schemaVersion: "1.0",
                agentVersionId: work.agentVersionId,
                triggerMessageId: work.triggerMessageId,
                locale: work.locale,
                evidence,
                textSha256: factDigest(responseText),
              },
            })}::jsonb
          WHERE id=${outbound.messageId}::uuid
        `;
        if (
          decision.action === "reply" ||
          decision.action === "knowledge" ||
          (decision.action === "request_call" && automaticCallQueued)
        ) {
          await transaction`
            UPDATE messaging.conversations
            SET unread_count=0, updated_at=CURRENT_TIMESTAMP
            WHERE id=${work.conversationId}::uuid AND ownership_mode='ai'
          `;
        }
      }
      await transaction`
        UPDATE ops.jobs SET status='succeeded', completed_at=CURRENT_TIMESTAMP,
          locked_at=NULL, locked_by=NULL, last_error_safe=NULL,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=${job.id}::uuid AND locked_by=${workerId}
      `;
    });
  } catch (error) {
    const reason =
      error instanceof WhatsAppAiProviderError
        ? error.code
        : error instanceof TypeError
          ? error.message
          : "AI reply failed";
    const permanent =
      error instanceof TypeError ||
      (error instanceof WhatsAppAiProviderError && !error.retryable);
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent) {
        await transaction`
          UPDATE ops.jobs SET max_attempts=attempts
          WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
        `;
      }
      await transaction`
        SELECT ops.fail_job(${job.id}::uuid, ${workerId}, ${reason}, 10)
      `;
    });
  }
}

interface AutomaticCallPayload {
  readonly agentVersionId: string;
  readonly canonicalFlowVersionId: string;
  readonly ownershipEpoch: string;
  readonly actorUserId: string;
  readonly contactId: string;
  readonly conversationId: string;
  readonly flowId: string;
  readonly flowVersion: number;
  readonly mode: "real";
  readonly triggerMessageId: string;
}

function parseAutomaticCallPayload(value: unknown): AutomaticCallPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("automatic call payload is invalid");
  const payload = value as Readonly<Record<string, unknown>>;
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
  if (
    payload.mode !== "real" ||
    typeof payload.agentVersionId !== "string" ||
    !uuid.test(payload.agentVersionId) ||
    typeof payload.canonicalFlowVersionId !== "string" ||
    !uuid.test(payload.canonicalFlowVersionId) ||
    typeof payload.ownershipEpoch !== "string" ||
    !/^\d{1,19}$/u.test(payload.ownershipEpoch) ||
    typeof payload.actorUserId !== "string" ||
    !uuid.test(payload.actorUserId) ||
    typeof payload.contactId !== "string" ||
    !uuid.test(payload.contactId) ||
    typeof payload.conversationId !== "string" ||
    !uuid.test(payload.conversationId) ||
    typeof payload.flowId !== "string" ||
    !uuid.test(payload.flowId) ||
    typeof payload.flowVersion !== "number" ||
    !Number.isInteger(payload.flowVersion) ||
    payload.flowVersion < 1 ||
    typeof payload.triggerMessageId !== "string" ||
    !uuid.test(payload.triggerMessageId)
  )
    throw new TypeError("automatic call payload is invalid");
  return payload as unknown as AutomaticCallPayload;
}

function conversationContext(
  messages: readonly {
    readonly content_text: string;
    readonly direction: "inbound" | "outbound";
  }[],
): string {
  const lines = messages.map((message) => {
    const label =
      message.direction === "inbound"
        ? "Customer report (unverified)"
        : "Prior assistant statement (unverified)";
    const text = message.content_text.replace(/\s+/gu, " ").trim();
    return `${label}: ${text}`;
  });
  const selected: string[] = [];
  let length = 0;
  for (const line of lines.toReversed()) {
    if (length + line.length + 1 > 3500) break;
    selected.unshift(line);
    length += line.length + 1;
  }
  if (selected.length === 0)
    throw new TypeError("automatic call conversation context is unavailable");
  return selected.join("\n");
}

async function loadAutomaticCallWork(
  sql: Sql,
  workerId: string,
  job: JobRow,
): Promise<AutomaticCallRequest> {
  const payload = parseAutomaticCallPayload(job.payload);
  if (
    job.reference_id !== payload.conversationId ||
    payload.conversationId === payload.contactId
  )
    throw new TypeError("automatic call job reference is invalid");
  return sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job.id);
    await requireCurrentTrigger(
      transaction,
      payload.conversationId,
      payload.triggerMessageId,
    );
    await transaction`
      SELECT set_config('app.current_user', ${payload.actorUserId}, true)
    `;
    const eligible = await transaction<
      {
        normalized_value: string;
        trigger_text: string;
        agent_version_id: string;
      }[]
    >`
      SELECT identity.normalized_value, trigger.content_text AS trigger_text, agent.id AS agent_version_id
      FROM messaging.conversations conversation
      JOIN agents.agent_profile_versions agent
        ON agent.id=conversation.ai_agent_profile_version_id AND agent.tenant_id=conversation.tenant_id
        AND agent.id=${payload.agentVersionId}::uuid AND agent.published_at IS NOT NULL
        AND agent.validation_status='valid' AND 'voice'=ANY(agent.channel_capabilities)
      JOIN automation.flow_versions canonical
        ON canonical.id=${payload.canonicalFlowVersionId}::uuid AND canonical.tenant_id=conversation.tenant_id
        AND canonical.agent_profile_version_id=agent.id AND canonical.published_at IS NOT NULL
        AND canonical.validation_status='valid'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(canonical.definition->'nodes') node
          WHERE node->>'type'='voice.call'
            AND node#>>'{configuration,flowId}'=${payload.flowId}
            AND node#>>'{configuration,flowVersion}'=${String(payload.flowVersion)})
      JOIN crm.contacts contact
        ON contact.id = conversation.contact_id
       AND contact.tenant_id = conversation.tenant_id
      JOIN LATERAL (
        SELECT candidate.normalized_value
        FROM crm.contact_channel_identities candidate
        WHERE candidate.contact_id = contact.id
          AND candidate.channel = 'whatsapp'
          AND candidate.normalized_value IS NOT NULL
          AND candidate.validation_status <> 'invalid'
        ORDER BY candidate.is_primary DESC,
                 candidate.created_at
        LIMIT 1
      ) identity ON true
      JOIN messaging.messages trigger
        ON trigger.id = ${payload.triggerMessageId}::uuid
       AND trigger.conversation_id = conversation.id
       AND trigger.direction = 'inbound'
       AND trigger.content_type = 'text'
      WHERE conversation.id = ${payload.conversationId}::uuid
        AND conversation.contact_id = ${payload.contactId}::uuid
        AND conversation.ownership_mode = 'ai'
        AND conversation.ai_enabled_by_user_id = ${payload.actorUserId}::uuid
        AND conversation.ownership_epoch = ${payload.ownershipEpoch}::bigint
        AND contact.lifecycle_status = 'active'
        AND contact.voice_consent <> 'revoked'
        AND platform.messaging_ai_actor_authorized(${payload.actorUserId}::uuid)
      FOR SHARE OF conversation, contact, trigger
    `;
    const row = eligible[0];
    if (
      row === undefined ||
      !/^\+[1-9][0-9]{7,14}$/u.test(row.normalized_value) ||
      !explicitlyRequestsImmediateCall(row.trigger_text)
    )
      throw new TypeError("automatic call eligibility changed");
    const flow = await transaction<
      { available: boolean }[]
    >`SELECT platform.voice_flow_available(
      ${payload.flowId}::uuid, ${payload.flowVersion}
    ) AS available`;
    if (flow[0]?.available !== true)
      throw new TypeError("automatic call flow is unavailable");
    const messages = await transaction<
      {
        content_text: string;
        direction: "inbound" | "outbound";
      }[]
    >`
      SELECT message.direction, message.content_text
      FROM messaging.messages message
      JOIN messaging.messages boundary
        ON boundary.id = ${payload.triggerMessageId}::uuid
       AND boundary.conversation_id = message.conversation_id
      WHERE message.conversation_id = ${payload.conversationId}::uuid
        AND message.content_type = 'text' AND message.content_text IS NOT NULL
        AND (message.created_at < boundary.created_at OR
             (message.created_at = boundary.created_at AND message.id <= boundary.id))
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT 12
    `;
    return {
      actorRole: "agent",
      actorUserId: payload.actorUserId,
      agentVersionId: row.agent_version_id,
      conversationContext: conversationContext(messages.reverse()),
      conversationId: payload.conversationId,
      destination: row.normalized_value,
      flowId: payload.flowId,
      flowVersion: payload.flowVersion,
      idempotencyKey: `whatsapp-auto-call:${job.id}`,
      jobId: job.id,
      tenantId: job.tenant_id,
    };
  });
}

async function processAutomaticCall(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
): Promise<void> {
  let payload: AutomaticCallPayload | undefined;
  try {
    if (
      automation.automaticCallsEnabled !== true ||
      automation.automaticCallProvider === undefined
    )
      throw new TypeError("automatic calls are disabled");
    payload = parseAutomaticCallPayload(job.payload);
    const work = await loadAutomaticCallWork(sql, workerId, job);
    // The dispatcher/provider request is deliberately outside any DB transaction.
    const result = await automation.automaticCallProvider.place(work);
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job.id);
      await transaction`
        UPDATE ops.jobs SET status='succeeded', completed_at=CURRENT_TIMESTAMP,
          locked_at=NULL, locked_by=NULL, last_error_safe=NULL,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
      `;
      await transaction`
        INSERT INTO audit.records
          (tenant_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES (platform.current_tenant_id(), ${work.actorUserId}::uuid,
                'conversation.call_started', 'conversation',
                ${work.conversationId}::uuid,
                ${transaction.json({
                  created: result.created,
                  jobId: job.id,
                  sessionId: result.sessionId,
                })})
      `;
    });
  } catch (error) {
    const reason =
      error instanceof AutomaticCallProviderError
        ? error.code
        : error instanceof TypeError
          ? error.message
          : "automatic call failed";
    const permanent =
      error instanceof TypeError ||
      (error instanceof AutomaticCallProviderError && !error.retryable);
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent)
        await transaction`
          UPDATE ops.jobs SET max_attempts=attempts
          WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
        `;
      await transaction`
        SELECT ops.fail_job(${job.id}::uuid, ${workerId}, ${reason}, 10)
      `;
      const dead = await transaction<{ dead: boolean }[]>`
        SELECT status='dead' AS dead FROM ops.jobs WHERE id=${job.id}::uuid
      `;
      if (dead[0]?.dead === true && payload !== undefined) {
        const stillOwned = await transaction<{ id: string }[]>`
          SELECT id FROM messaging.conversations WHERE id=${payload.conversationId}::uuid
            AND ownership_mode='ai' AND ai_enabled_by_user_id=${payload.actorUserId}::uuid
            AND ownership_epoch=${payload.ownershipEpoch}::bigint FOR UPDATE
        `;
        // A failed old generation must not overwrite a later takeover/resume.
        if (stillOwned[0] === undefined) return;
        const fallbackReason = "Automatic telephone call could not be started";
        await transaction`
          INSERT INTO automation.handoffs
            (tenant_id, contact_id, conversation_id, requested_by_user_id,
             source_channel, reason_safe, status, idempotency_key)
          VALUES (platform.current_tenant_id(), ${payload.contactId}::uuid,
                  ${payload.conversationId}::uuid, ${payload.actorUserId}::uuid,
                  'whatsapp', ${fallbackReason}, 'pending',
                  ${`auto-call-failed:${job.id}`})
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        `;
        await transaction`
          UPDATE messaging.conversations
          SET ownership_mode='human', ai_agent_profile_version_id=NULL,
              ai_enabled_by_user_id=NULL, ai_enabled_at=NULL,
              handoff_reason_safe=${fallbackReason}, updated_at=CURRENT_TIMESTAMP
          WHERE id=${payload.conversationId}::uuid
        `;
        await transaction`
          INSERT INTO audit.records
            (tenant_id, actor_user_id, action, target_type, target_id, metadata)
          VALUES (platform.current_tenant_id(), ${payload.actorUserId}::uuid,
                  'conversation.call_failed', 'conversation',
                  ${payload.conversationId}::uuid,
                  ${transaction.json({ errorCode: reason, jobId: job.id })})
        `;
      }
    });
  }
}

async function requireOwnedJob(
  transaction: postgres.TransactionSql,
  workerId: string,
  jobId: string,
): Promise<void> {
  const owned = await transaction<{ id: string }[]>`
    SELECT id FROM ops.jobs WHERE id=${jobId}::uuid AND status='running'
      AND locked_by=${workerId} AND locked_at > CURRENT_TIMESTAMP-INTERVAL '60 seconds'
    FOR UPDATE
  `;
  if (owned.length !== 1)
    throw new WhatsAppProviderError("stale_worker_claim", false);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value)
  );
}

async function requireGroundedOutbound(
  transaction: postgres.TransactionSql,
  row: {
    readonly provider_payload: unknown;
    readonly content_text: string | null;
    readonly conversation_id: string;
    readonly requested_by_user_id: string;
  },
): Promise<void> {
  const metadata = record(record(row.provider_payload).aiGrounding);
  const evidence = record(metadata.evidence);
  if (
    metadata.schemaVersion !== "1.0" ||
    !uuid(metadata.agentVersionId) ||
    !uuid(metadata.triggerMessageId) ||
    typeof metadata.locale !== "string" ||
    metadata.textSha256 !== factDigest(row.content_text ?? "")
  )
    throw new WhatsAppProviderError("ai_evidence_invalid", false);
  await transaction`SELECT set_config('app.current_user', ${row.requested_by_user_id}, true)`;
  try {
    await requireCurrentTrigger(
      transaction,
      row.conversation_id,
      metadata.triggerMessageId,
    );
  } catch (error) {
    if (error instanceof TypeError)
      throw new WhatsAppProviderError("ai_trigger_superseded", false);
    throw error;
  }
  let expected: string | undefined;
  if (
    evidence.kind === "knowledge" &&
    typeof evidence.documentId === "string" &&
    typeof evidence.factKey === "string"
  ) {
    const grounded = groundAiReply(
      {
        action: "knowledge",
        text: "",
        documentId: evidence.documentId,
        factKey: evidence.factKey,
      },
      await eligibleFacts(transaction, metadata.agentVersionId),
      metadata.locale,
    );
    if (
      grounded.evidence.kind === "knowledge" &&
      grounded.evidence.sourceId === evidence.sourceId &&
      grounded.evidence.version === evidence.version &&
      grounded.evidence.valueSha256 === evidence.valueSha256
    )
      expected = grounded.text;
  } else if (evidence.kind === "conversation") {
    // Reuse the closed selection decoder; malformed codes cannot authorize prose.
    const codes = [
      "greeting",
      "thanks",
      "clarify",
      "unverified_claim",
      "knowledge_unavailable",
    ] as const;
    const code = codes.find((item) => item === evidence.code);
    if (code !== undefined)
      expected = groundAiReply(
        { action: "reply", text: "", replyCode: code },
        [],
        metadata.locale,
      ).text;
  } else if (evidence.kind === "receipt" && uuid(evidence.resourceId)) {
    if (evidence.operation === "handoff") {
      const receipt = await transaction<{ id: string }[]>`
        SELECT id FROM automation.handoffs WHERE id=${evidence.resourceId}::uuid
          AND conversation_id=${row.conversation_id}::uuid
          AND requested_by_user_id=${row.requested_by_user_id}::uuid AND status='pending'
      `;
      if (receipt[0] !== undefined)
        expected = actionReceiptReply("handoff", metadata.locale);
    } else if (evidence.operation === "callback") {
      const receipt = await transaction<{ id: string }[]>`
        SELECT id FROM ops.jobs WHERE id=${evidence.resourceId}::uuid
          AND reference_id=${row.conversation_id}::uuid AND job_type='whatsapp.ai.call'
          AND payload->>'actorUserId'=${row.requested_by_user_id}
          AND payload->>'triggerMessageId'=${metadata.triggerMessageId}
          AND status IN ('queued','running','retry','succeeded')
      `;
      if (receipt[0] !== undefined)
        expected = actionReceiptReply("callback", metadata.locale);
    }
  }
  if (expected === undefined || expected !== row.content_text)
    throw new WhatsAppProviderError("ai_evidence_changed", false);
}

async function revalidateOutboundAttempt(
  sql: Sql,
  workerId: string,
  job: JobRow,
  work: OutboundWork,
): Promise<void> {
  await sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job.id);
    const rows = await transaction<
      {
        content_text: string | null;
        provider_payload: unknown;
        conversation_id: string;
        requested_by_user_id: string;
        sender_type: string;
      }[]
    >`
      SELECT message.content_text, message.provider_payload, request.conversation_id,
             request.requested_by_user_id, message.sender_type
      FROM messaging.outbound_requests request
      JOIN messaging.messages message ON message.id=request.message_id
      JOIN messaging.conversations conversation ON conversation.id=request.conversation_id
      JOIN messaging.channels channel ON channel.id=request.channel_id
      JOIN crm.contact_channel_identities identity ON identity.id=request.recipient_identity_id
      JOIN crm.contacts contact ON contact.id=conversation.contact_id
      WHERE request.id=${work.requestId}::uuid AND request.status='sending'
        AND request.message_id=${work.messageId}::uuid
        AND channel.status='active' AND channel.provider=request.provider
        AND request.provider=${work.provider} AND identity.normalized_value=${work.recipient}
        AND identity.contact_id=contact.id AND identity.validation_status='valid'
        AND contact.lifecycle_status='active'
        AND platform.messaging_ai_actor_authorized(request.requested_by_user_id)
        AND (message.sender_type <> 'agent' OR request.ai_ownership_epoch=conversation.ownership_epoch)
        AND (request.provider <> 'meta' OR (
          request.explicitly_confirmed AND contact.whatsapp_consent='granted'
          AND contact.whatsapp_opted_out_at IS NULL
          AND channel.provider_account_id=${work.senderPhoneNumberId ?? null}
          AND (request.message_kind='template' OR conversation.customer_service_window_expires_at>CURRENT_TIMESTAMP)))
    `;
    const row = rows[0];
    if (
      row === undefined ||
      (work.delivery.kind === "text" && row.content_text !== work.delivery.text)
    )
      throw new WhatsAppProviderError("outbound_eligibility_changed", false);
    if (row.sender_type === "agent")
      await requireGroundedOutbound(transaction, row);
  });
}

async function loadOutboundWork(
  sql: Sql,
  workerId: string,
  job: JobRow,
): Promise<OutboundWork> {
  return sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job.id);
    const previous = await transaction<{ status: string }[]>`
      SELECT status FROM messaging.outbound_requests WHERE id=${job.reference_id}::uuid FOR UPDATE
    `;
    if (previous[0]?.status === "sending")
      throw new WhatsAppProviderError("delivery_outcome_unknown", false);
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
        sender_phone_number_id: string | null;
        sender_type: string;
        conversation_id: string;
        requested_by_user_id: string;
        provider_payload: unknown;
      }[]
    >`
      UPDATE messaging.outbound_requests request
      SET status = 'sending', attempted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      FROM messaging.messages message, crm.contact_channel_identities identity,
           messaging.conversations conversation, messaging.channels channel, crm.contacts contact
      WHERE request.id = ${job.reference_id}::uuid
        AND request.tenant_id = platform.current_tenant_id()
        AND request.message_id = message.id
        AND request.recipient_identity_id = identity.id
        AND request.status = 'queued'
        AND request.conversation_id = conversation.id AND message.conversation_id = conversation.id
        AND request.channel_id = channel.id AND conversation.channel_id = channel.id
        AND channel.status = 'active' AND channel.provider = request.provider
        AND conversation.contact_id = contact.id AND identity.contact_id = contact.id
        AND identity.validation_status = 'valid' AND contact.lifecycle_status = 'active'
        AND platform.messaging_ai_actor_authorized(request.requested_by_user_id)
        AND (message.sender_type <> 'agent' OR request.ai_ownership_epoch = conversation.ownership_epoch)
        AND (request.provider <> 'meta' OR (
          request.explicitly_confirmed AND contact.whatsapp_consent='granted'
          AND contact.whatsapp_opted_out_at IS NULL
          AND channel.provider_account_id IS NOT NULL
          AND (request.message_kind='template' OR conversation.customer_service_window_expires_at > CURRENT_TIMESTAMP)
        ))
      RETURNING request.id AS request_id, request.message_id, request.provider,
                request.message_kind, request.idempotency_key, request.template_name,
                request.template_language, request.template_parameters AS parameters,
                message.content_text, message.sender_type, message.provider_payload,
                request.conversation_id, request.requested_by_user_id,
                identity.normalized_value, channel.provider_account_id AS sender_phone_number_id
    `;
    const row = rows[0];
    if (row === undefined)
      throw new WhatsAppProviderError("outbound_eligibility_changed", false);
    if (row.sender_type === "agent")
      await requireGroundedOutbound(transaction, row);
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
      senderPhoneNumberId: row.sender_phone_number_id ?? undefined,
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
  reportFailure:
    | ((failure: MessageDeliveryFailure & { readonly jobId: string }) => void)
    | undefined,
  simulatorEnabled: boolean,
): Promise<void> {
  let work: OutboundWork | undefined;
  try {
    work = await loadOutboundWork(sql, workerId, job);
    const outboundWork = work;
    const providerName = outboundWork.provider;
    if (providerName === "simulator" && !simulatorEnabled)
      throw new WhatsAppProviderError("simulation_disabled", false);

    // The external request intentionally runs outside every PostgreSQL transaction.
    const result = await providers[providerName].send({
      recipient: outboundWork.recipient,
      idempotencyKey: outboundWork.idempotencyKey,
      delivery: outboundWork.delivery,
      beforeAttempt: () =>
        revalidateOutboundAttempt(sql, workerId, job, outboundWork),
      ...(outboundWork.senderPhoneNumberId === undefined
        ? {}
        : { senderPhoneNumberId: outboundWork.senderPhoneNumberId }),
    });
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, outboundWork.tenantId);
      await requireOwnedJob(transaction, workerId, job.id);
      const status = providerName === "simulator" ? "delivered" : "sent";
      await transaction`
        UPDATE messaging.outbound_requests
        SET status = CASE WHEN status IN ('delivered','read') THEN status ELSE ${status} END, provider_message_id = ${result.messageId},
            completed_at = CASE WHEN ${status} = 'delivered' THEN CURRENT_TIMESTAMP ELSE NULL END,
            last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${outboundWork.requestId}::uuid
      `;
      await transaction`
        UPDATE messaging.messages
        SET status = CASE WHEN status IN ('delivered','read') THEN status ELSE ${status} END, provider_message_id = ${result.messageId}, updated_at = CURRENT_TIMESTAMP,
            provider_payload = provider_payload - 'whatsappSendDiagnostic'
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
    if (
      error instanceof WhatsAppProviderError &&
      error.code === "stale_worker_claim"
    )
      return;
    const failure = messageDeliveryFailure(
      error instanceof WhatsAppProviderError
        ? error.code
        : work?.provider === "meta"
          ? "delivery_outcome_unknown"
          : "outbound_processing_failed",
      error instanceof WhatsAppProviderError ? error.diagnostic : null,
    ) ?? { code: "outbound_processing_failed", diagnostic: null };
    const code = failure.code;
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      const owned = await transaction<{ id: string }[]>`SELECT id FROM ops.jobs
        WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId} FOR UPDATE`;
      if (owned.length !== 1) return;
      if (!retryable) {
        await transaction`
          UPDATE ops.jobs SET max_attempts = attempts WHERE id = ${job.id}::uuid
        `;
      }
      await transaction`
        SELECT ops.fail_job(${job.id}::uuid, ${workerId}, ${code}, 5)
      `;
      if (job.reference_id !== null) {
        await transaction`
          UPDATE messaging.outbound_requests request
          SET status = CASE
                WHEN (SELECT status FROM ops.jobs WHERE id = ${job.id}::uuid) = 'dead'
                  THEN 'failed' ELSE 'queued' END,
              last_error_code = ${code}, updated_at = CURRENT_TIMESTAMP,
              completed_at = CASE
                WHEN (SELECT status FROM ops.jobs WHERE id = ${job.id}::uuid) = 'dead'
                  THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE request.id = ${job.reference_id}::uuid
            AND request.status IN ('queued','sending')
        `;
        await transaction`
          UPDATE messaging.messages SET status = CASE
            WHEN (SELECT status FROM ops.jobs WHERE id = ${job.id}::uuid) = 'dead'
              THEN 'failed' ELSE 'queued' END,
            updated_at = CURRENT_TIMESTAMP,
            provider_payload = jsonb_set(COALESCE(provider_payload, '{}'::jsonb),
              '{whatsappSendDiagnostic}', COALESCE(${transaction.json(failure.diagnostic === null ? null : { ...failure.diagnostic })}::jsonb, 'null'::jsonb), true)
          WHERE id = (SELECT message_id FROM messaging.outbound_requests WHERE id=${job.reference_id}::uuid)
            AND status IN ('queued','sending')
        `;
      }
    });
    reportFailure?.({ ...failure, jobId: job.id });
  }
}

export function createMessagingStore(
  databaseUrl: string,
  workerId: string,
  providers: Readonly<Record<"simulator" | "meta", WhatsAppProvider>>,
  reportFailure?: (
    failure: MessageDeliveryFailure & { readonly jobId: string },
  ) => void,
  automation: MessagingAutomationOptions = {},
): MessagingStore {
  const sql = postgres(databaseUrl, {
    connect_timeout: 2,
    idle_timeout: 10,
    max: 4,
    prepare: false,
    connection: { statement_timeout: 10000 },
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
        FROM ops.claim_inbound_events(${workerId}, 1, 60)
      `;
      for (const event of events)
        await processInbound(
          sql,
          workerId,
          event,
          automation.aiProvider !== undefined,
          automation.realWhatsAppEnabled === true,
        );

      const jobs = await sql<JobRow[]>`
        SELECT id, tenant_id, job_type, reference_id, payload
        FROM ops.claim_jobs_all_tenants(${workerId}, 'messaging', 1, 60)
      `;
      for (const job of jobs)
        await processJob(
          sql,
          workerId,
          job,
          providers,
          reportFailure,
          automation,
        );
      return events.length + jobs.length;
    },
  };
}
