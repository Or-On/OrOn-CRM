import {
  createMemorySummaryModelProvider,
  type SummaryModelProjection,
} from "./memory-summary-model.js";
import {
  processMemorySummaryJob,
  type MemorySummaryProvider,
  type MemorySummaryWork,
} from "./memory-summary-job.js";
import postgres, { type Sql } from "postgres";
import { randomUUID } from "node:crypto";
import type { ModelAccountingSpool } from "./model-accounting-spool.js";
import {
  AiPrincipalDeniedError,
  parsePrincipalAdmission,
  retainPrincipalAdmission,
  type PrincipalAdmission,
} from "./ai-principal.js";
import type { ChannelCredentialEnvelope } from "./channel-credentials.js";
import { authorizeMachineTool } from "./machine-tools.js";
import {
  createOpeningMenuStore,
  openingMenuBusinessJobAllowed,
  type StoredOpeningMenuDecision,
} from "./opening-menu-database.js";
import { processOpeningMenuJob } from "./opening-menu-job.js";
import { createOpeningMenuProvider } from "./opening-menu-provider.js";
import type {
  ModelCredentialEnvelope,
  ResolvedModelCredential,
} from "./model-credentials.js";
import {
  resolveTrustedModelRoute,
  type ModelRoutingPorts,
  type PublishedModelBinding,
  type ModelConfigurationRecord,
  type TrustedModelRoute,
} from "./trusted-model-routing.js";
import { setTimeout as leaseDelay } from "node:timers/promises";
import { messageContextText } from "./message-context.js";
import {
  queueDebouncedReply,
  requireNoNewerPendingInbound,
} from "./inbound-debounce.js";
import { acknowledgeCommittedInbound } from "./inbound-typing.js";
import { queueAutoGreeting } from "./auto-greeting.js";
import {
  digitalServiceFormPending,
  resumeDigitalFormFollowup,
} from "./digital-form-guard.js";
import {
  unsupportedInboundMedia,
  unsupportedMediaReply,
} from "./unsupported-media.js";
import { loadSessionMemoryContext } from "./session-memory-context.js";
import { loadAiAuthoredContextIds } from "./ai-authored-context.js";
import {
  runAudioTranscriptionWork,
  type AudioWorkBinding,
} from "./audio-transcription-work.js";
import { createAudioWorkTransaction } from "./audio-transcription-database.js";
import type { AudioTranscriber } from "./audio-transcription.js";
import {
  remediationEnabled,
  modelFailureReply,
  type OperatorAlertProvider,
} from "./remediation-policy.js";

import {
  deliverSimulatorBroadcastRecipient,
  deliverSimulatedCallFollowup,
  advanceCanonicalSimulation,
  ingestWhatsAppInbound,
  ingestWhatsAppCoexistence,
  ingestWhatsAppStatus,
  parseStoredWhatsAppEnvelope,
  parseStoredWhatsAppStatusEnvelope,
  messageDeliveryFailure,
  loadEligibleAgentKnowledge,
  retrieveAgentKnowledge,
  applyCustomerConfirmation,
  applyPostCallOutcome,
  awaitingCustomerTicket,
  beginPostCallAnalysis,
  bindTicketCallAttemptSession,
  callOutcomeFromSession,
  classifyCustomerReply,
  failPostCallAnalysis,
  followupMessage,
  loadCallEvidence,
  loadFollowupPlan,
  loadPostCallWork,
  openTicketCallAttempt,
  openOrAttachTicket,
  recordArtifactVerification,
  recordFollowupOutcome,
  recordPostCallAnalysis,
  recordTicketEvent,
  schedulePostCallFollowup,
  setTicketHandlingMode,
  skipPostCallAnalysis,
  queueWhatsAppAutomaticCall,
  queueWhatsAppOutbound,
  issueDigitalServiceForm,
  assignDefaultWhatsAppAi,
  createInboundConversationNotifications,
  captureWhatsAppServiceIntakeMessage,
  confirmWhatsAppServiceIntake,
  findOpenWhatsAppServiceIntake,
  getFieldServiceFeatureState,
  getServiceWorkflowPolicy,
  parseServiceWorkflowPolicy,
  handoffWhatsAppServiceIntake,
  missingIntakeFields,
  commitPrivateObject,
  discardPrivateObject,
  protectNationalIdWithKeys,
  readPrivateObject,
  sanitizeIntakeProposal,
  stagePrivateObject,
  updateWhatsAppServiceIntake,
  buildAgentExecutionContract,
  capabilityRequiredFeature,
  ensureLeadForInteraction,
  executeLeadTool,
  findInteractionLead,
  hasCapability,
  leadCompleteness,
  loadLeadFieldSchema,
  pinnedLeadFieldSchemaId,
  LeadToolError,
  type AgentExecutionContract,
  type LeadBinding,
  type LeadToolContext,
  type LeadToolName,
  type LeadToolResult,
  type ProtectedFieldKeys,
  type PrivateObjectStorageOptions,
  type StagedPrivateObject,
  type MessageDeliveryFailure,
  agentScopePolicyVersion,
  approvedAgentResponse,
  approvedAgentResponses,
  classifyCustomerTurn,
  validateAgentOutput,
} from "@or-on/crm";

import type { WhatsAppProvider, WhatsAppSendRequest } from "./providers.js";
import { WhatsAppProviderError } from "./providers.js";
import {
  WhatsAppAiProviderError,
  type WhatsAppActionReceipt,
  type WhatsAppAiDecision,
  type WhatsAppAiEscalationReason,
  type WhatsAppAiProvider,
  type WhatsAppAiRequest,
  type WhatsAppAiAttempt,
} from "./ai-provider.js";
import {
  AutomaticCallProviderError,
  type AutomaticCallProvider,
  type AutomaticCallRequest,
} from "./call-provider.js";
import {
  actionReceiptReply,
  conversationReplyCodes,
  enforceStandaloneCallbackConsent,
  deferUnconfirmedContextHandoff,
  explicitlyRequestsImmediateCall,
  factDigest,
  groundAiReply,
  latestMessageLocale,
  recentReplyWindowSize,
  safeConversationalReply,
  type CommittedRecord,
  type EligibleKnowledgeFact,
  type GroundedReply,
} from "./ai-grounding.js";
import {
  tenantBusinessContext,
  type TenantBusinessContext,
} from "./tenant-business-context.js";
import {
  followupDelivery,
  followupTemplateParameters,
  renderIntakeFollowup,
  type IntakeFollowupPlan,
} from "./intake-followup.js";
import {
  FieldServiceAiProviderError,
  type FieldServiceAiProvider,
} from "./field-service-provider.js";
import {
  ArtifactVerifierError,
  type ArtifactVerifier,
} from "./artifact-verifier.js";
import {
  PostCallProviderError,
  type PostCallAnalysisProvider,
} from "./post-call-provider.js";

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
  claim_token: string;
  claimLost?: boolean;
}

interface OpeningMenuRoute {
  readonly intent: "services" | "support";
  readonly language: "he" | "en";
  readonly agentVersionId: string;
  readonly allowedCapabilities: readonly string[];
}

function menuRoute(
  decision: StoredOpeningMenuDecision,
): OpeningMenuRoute | undefined {
  if (decision.kind !== "route") return undefined;
  if (
    (decision.intent !== "services" && decision.intent !== "support") ||
    (decision.language !== "he" && decision.language !== "en") ||
    typeof decision.agentVersionId !== "string" ||
    !Array.isArray(decision.allowedCapabilities)
  )
    throw new TypeError("Canonical opening menu route unavailable");
  return {
    intent: decision.intent,
    language: decision.language,
    agentVersionId: decision.agentVersionId,
    allowedCapabilities: decision.allowedCapabilities,
  };
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
  /** Finish currently admitted replies without admitting new work. */
  readonly drainReplies: () => Promise<void>;
}

export interface MessagingAutomationOptions {
  readonly publicSiteUrl?: string;
  readonly memorySummaryProvider?: MemorySummaryProvider;
  /** Trusted test/server transport; absent uses native HTTPS fetch. */
  readonly memorySummaryFetch?: typeof fetch;
  readonly resolveChannelCredential?: (
    envelope: ChannelCredentialEnvelope,
  ) => string;
  /** Trusted server adapters; explicit bindings never inherit deployment keys. */
  readonly modelRouting?: {
    readonly resolveSealedCredential?: (
      envelope: ModelCredentialEnvelope,
    ) => ResolvedModelCredential;
    readonly resolveCredential?: ModelRoutingPorts<{
      readonly apiKey: string;
    }>["resolveCredential"];
    readonly reserveDailyAttempt?: ModelRoutingPorts<{
      readonly apiKey: string;
    }>["reserveDailyAttempt"];
    readonly createProvider: (
      route: Extract<
        TrustedModelRoute<{ readonly apiKey: string }>,
        { readonly status: "configured" }
      >,
    ) => WhatsAppAiProvider;
  };
  readonly audioTranscriber?: AudioTranscriber;
  readonly modelAccountingSpool?: ModelAccountingSpool;
  readonly beforeModelAttempt?: () => Promise<void>;
  readonly modelAttemptRecorder?: (
    context: {
      readonly tenantId: string;
      readonly jobId: string;
      readonly agentVersionId: string;
    },
    attempt: WhatsAppAiAttempt,
  ) => Promise<void>;
  readonly operatorAlertProvider?: OperatorAlertProvider;
  readonly simulatorEnabled?: boolean;
  readonly aiProvider?: WhatsAppAiProvider;
  readonly automaticCallProvider?: AutomaticCallProvider;
  readonly automaticCallsEnabled?: boolean;
  readonly realWhatsAppEnabled?: boolean;
  readonly fieldServiceProvider?: FieldServiceAiProvider;
  readonly protectedFieldKeys?: ProtectedFieldKeys;
  readonly privateObjectStorage?: PrivateObjectStorageOptions;
  /** Reads a call's stored artifacts to decide whether they are usable. */
  readonly artifactVerifier?: ArtifactVerifier;
  readonly postCallProvider?: PostCallAnalysisProvider;
  readonly postCallModel?: string;
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

class TenantFeatureRuntimeError extends TypeError {
  readonly code = "tenant_feature_disabled";
}

async function requireTenantFeatures(
  transaction: postgres.TransactionSql,
  features: readonly string[],
): Promise<void> {
  const unique = [...new Set(features)];
  const rows = await transaction<{ feature: string; enabled: boolean }[]>`
    SELECT requested.feature,
      platform.current_tenant_feature_enabled(requested.feature) AS enabled
    FROM unnest(${unique}::text[]) requested(feature)
  `;
  const disabled = rows.filter((row) => !row.enabled).map((row) => row.feature);
  if (disabled.length > 0)
    throw new TenantFeatureRuntimeError(
      `tenant feature disabled: ${disabled.join(", ")}`,
    );
}

async function processInbound(
  sql: Sql,
  workerId: string,
  event: InboundEventRow,
  aiEnabled: boolean,
  realWhatsAppEnabled: boolean,
  fieldServiceAiAvailable: boolean,
  acknowledgementProvider?: WhatsAppProvider,
  resolveChannelCredential?: MessagingAutomationOptions["resolveChannelCredential"],
): Promise<void> {
  let committedInbound:
    { tenantId: string; conversationId: string; messageId: string } | undefined;
  try {
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, event.tenant_id);
      if (event.event_type.startsWith("whatsapp.coexistence.")) {
        await ingestWhatsAppCoexistence(transaction, event.payload);
      } else if (event.event_type === "whatsapp.message.status") {
        const envelope = parseStoredWhatsAppStatusEnvelope(event.payload);
        if (envelope === undefined)
          throw new TypeError("invalid status envelope");
        await ingestWhatsAppStatus(transaction, envelope);
      } else {
        const envelope = parseStoredWhatsAppEnvelope(event.payload);
        if (envelope === undefined)
          throw new TypeError("invalid inbound envelope");
        const result = await ingestWhatsAppInbound(transaction, envelope);
        if (result.inserted && result.messageId !== undefined) {
          committedInbound = {
            tenantId: event.tenant_id,
            conversationId: result.conversationId,
            messageId: result.messageId,
          };
          await createInboundConversationNotifications(
            transaction,
            result.conversationId,
          );
          if (envelope.contentType === "event") {
            // Reactions and unknown provider events are durable UI data. They
            // cannot trigger model spending, wrap-up decisions or business tools.
            committedInbound = undefined;
            await transaction`SELECT ops.complete_inbound_event(${event.id}::uuid,${workerId})`;
            return;
          }
          if (aiEnabled && realWhatsAppEnabled)
            await assignDefaultWhatsAppAi(transaction, result.conversationId);
          if (aiEnabled && realWhatsAppEnabled)
            await transaction`SELECT platform.enqueue_opening_menu_for_inbound(${result.messageId}::uuid)`;
          // Queued before any AI work so the greeting is the first reply.
          if (realWhatsAppEnabled)
            await queueAutoGreeting(transaction, result.messageId);
          // Plain messages and media are retained as conversation data. They
          // cannot submit a web form or open its case, even before a link has
          // been delivered (for example, when the service window is closed).
          const formReply = await digitalServiceFormPending(
            transaction,
            result.conversationId,
          );
          if (formReply && realWhatsAppEnabled)
            await resumeDigitalFormFollowup(transaction, result.messageId);
          const unsupportedStorage = unsupportedInboundMedia(envelope);
          if (
            (unsupportedStorage || envelope.contentType === "video") &&
            (await remediationEnabled(transaction, "no_silence"))
          ) {
            await transaction`UPDATE messaging.messages SET structured_content=
              coalesce(structured_content,'{}'::jsonb)||${transaction.json(
                unsupportedStorage
                  ? { retrievalStatus: "unsupported" }
                  : { agentMediaStatus: "unsupported" },
              )}::jsonb
              WHERE id=${result.messageId}::uuid`;
            if (aiEnabled && realWhatsAppEnabled && !formReply)
              await transaction`
              INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,
                idempotency_key,max_attempts,priority)
              SELECT platform.current_tenant_id(),'messaging','whatsapp.unsupported.reply','conversation',
                c.id,jsonb_build_object('triggerMessageId',${result.messageId}::uuid,
                  'ownershipEpoch',c.ownership_epoch::text,'agentVersionId',c.ai_agent_profile_version_id,
                  'authorizedUserId',c.ai_enabled_by_user_id),
                ${`whatsapp-unsupported:${result.messageId}`},3,100
              FROM messaging.conversations c JOIN agents.agent_profile_versions a
                ON a.id=c.ai_agent_profile_version_id AND a.tenant_id=c.tenant_id
              WHERE c.id=${result.conversationId}::uuid AND c.ownership_mode='ai'
                AND c.removed_from_inbox_at IS NULL AND a.published_at IS NOT NULL
                AND a.validation_status='valid'
                AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
              ON CONFLICT DO NOTHING`;
            if (unsupportedStorage) {
              await transaction`SELECT ops.complete_inbound_event(${event.id}::uuid,${workerId})`;
              return;
            }
          }
          if (envelope.media !== undefined)
            await transaction`
              INSERT INTO ops.jobs
                (tenant_id, queue, job_type, reference_type, reference_id, payload,
                 idempotency_key, max_attempts, priority)
              SELECT platform.current_tenant_id(), 'messaging',
                     'whatsapp.media.retrieve', 'message',
                     ${result.messageId}::uuid,
                     ${transaction.json({
                       conversationId: result.conversationId,
                       messageId: result.messageId,
                       mediaId: envelope.media.id,
                       contentType: envelope.contentType,
                       expectedMimeType: envelope.media.mimeType,
                       expectedSha256: envelope.media.sha256,
                     })},
                     ${`whatsapp:media:${result.messageId}`}, 4, 30
              FROM messaging.messages message
              JOIN messaging.conversations conversation
                ON conversation.id=message.conversation_id
               AND conversation.tenant_id=message.tenant_id
              JOIN messaging.channels channel
                ON channel.id=conversation.channel_id
               AND channel.tenant_id=conversation.tenant_id
              WHERE message.id=${result.messageId}::uuid
                AND message.direction='inbound' AND message.provider='meta'
                AND channel.provider='meta' AND channel.status='active'
                AND channel.mirror_inbound_media
              ON CONFLICT DO NOTHING
            `;
          if (envelope.media !== undefined)
            await transaction`
              UPDATE messaging.messages message SET
                structured_content=jsonb_set(
                  coalesce(message.structured_content, '{}'::jsonb) - 'retrievalError',
                  '{retrievalStatus}', '"unavailable"'::jsonb, true),
                updated_at=CURRENT_TIMESTAMP
              WHERE message.id=${result.messageId}::uuid
                AND message.object_id IS NULL
                AND (
                  NOT ${realWhatsAppEnabled}
                  OR NOT EXISTS (
                    SELECT 1 FROM ops.jobs job
                    WHERE job.tenant_id=message.tenant_id
                      AND job.queue='messaging'
                      AND job.idempotency_key=${`whatsapp:media:${result.messageId}`}
                      AND job.status IN ('queued','running','retry','succeeded')
                  )
                )
            `;
          await transaction`
            INSERT INTO ops.jobs
              (tenant_id, queue, job_type, reference_type, reference_id, payload,
               idempotency_key, max_attempts, priority)
            SELECT platform.current_tenant_id(), 'messaging',
                   'field_service.intake.extract', 'message',
                   ${result.messageId}::uuid,
                   jsonb_build_object(
                     'conversationId', ${result.conversationId}::uuid,
                     'contactId', ${result.contactId}::uuid,
                     'triggerMessageId', ${result.messageId}::uuid),
                   ${`field-service:intake:${result.messageId}`}, 4,
                   CASE WHEN EXISTS(SELECT 1 FROM platform.tenant_remediation_flags
                     WHERE tenant_id=platform.current_tenant_id() AND flag_key='queue_priority' AND enabled)
                     THEN 10 ELSE 20 END
            FROM platform.tenant_feature_entitlements entitlement
            JOIN service.tenant_configuration configuration
              ON configuration.tenant_id=entitlement.tenant_id
            WHERE entitlement.tenant_id=platform.current_tenant_id()
              AND entitlement.feature_key='field_service'
              AND entitlement.available AND configuration.enabled
              AND configuration.whatsapp_intake_enabled
              AND service.current_workflow_policy()#>>'{whatsappFollowUp,mode}' IS DISTINCT FROM 'form'
              AND ${fieldServiceAiAvailable && !formReply && envelope.contentType !== "audio" && envelope.contentType !== "video"}
              AND EXISTS(SELECT 1 FROM messaging.conversations c JOIN agents.agent_profile_versions a ON a.tenant_id=c.tenant_id AND a.id=c.ai_agent_profile_version_id
                WHERE c.id=${result.conversationId}::uuid AND c.tenant_id=entitlement.tenant_id AND c.ownership_mode='ai'
                  AND a.published_at IS NOT NULL AND a.validation_status='valid' AND a.tool_permissions ? 'service.intake'
                  AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id))
            ON CONFLICT DO NOTHING
          `;
          // A wrap-up reply is answered before the ordinary AI turn is even
          // considered: the customer was asked a specific question about a
          // specific ticket, and that answer belongs on that ticket whether or
          // not the conversation is still AI-owned.
          await transaction`
            INSERT INTO ops.jobs
              (tenant_id, queue, job_type, reference_type, reference_id, payload,
               idempotency_key, max_attempts, priority)
            SELECT platform.current_tenant_id(), 'messaging',
                   'support.postcall.reply', 'conversation',
                   ${result.conversationId}::uuid,
                   jsonb_build_object('conversationId', ${result.conversationId}::uuid,
                     'messageId', ${result.messageId}::uuid),
                   ${`support-postcall-reply:${result.messageId}`}, 3, 30
            WHERE ${!formReply} AND EXISTS (
              SELECT 1 FROM support.tickets ticket
              WHERE ticket.tenant_id = platform.current_tenant_id()
                AND ticket.source_conversation_id = ${result.conversationId}::uuid
                AND ticket.status = 'open' AND ticket.stage = 'awaiting_customer'
            )
            ON CONFLICT DO NOTHING
          `;
          const debounced =
            aiEnabled &&
            !formReply &&
            envelope.contentType !== "audio" &&
            envelope.contentType !== "video"
              ? await queueDebouncedReply(transaction, {
                  conversationId: result.conversationId,
                  messageId: result.messageId,
                  eventId: event.id,
                })
              : { handled: false };
          if (!debounced.handled && !formReply)
            await transaction`
            INSERT INTO ops.jobs
              (tenant_id, queue, job_type, reference_type, reference_id, payload,
               idempotency_key, max_attempts, priority)
            SELECT platform.current_tenant_id(), 'messaging', 'whatsapp.ai.reply',
                   'conversation', ${result.conversationId}::uuid,
                   jsonb_build_object('conversationId', ${result.conversationId}::uuid,
                     'triggerMessageId', ${result.messageId}::uuid),
                   ${`whatsapp-ai:${event.id}`}, 3,
                   CASE WHEN EXISTS(SELECT 1 FROM platform.tenant_remediation_flags
                     WHERE tenant_id=platform.current_tenant_id() AND flag_key='queue_priority' AND enabled)
                     THEN 100 ELSE 0 END
            WHERE ${aiEnabled && envelope.contentType !== "audio" && envelope.contentType !== "video"} AND EXISTS (
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
    // The failed ingress transaction above rolled back. Commit operator
    // evidence separately so exhaustion is visible even when no AI job exists
    // or a later agent transaction loses ownership and must roll back.
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, event.tenant_id);
      await transaction`SELECT ops.surface_exhausted_inbound()`;
    });
    return;
  }
  if (
    committedInbound !== undefined &&
    realWhatsAppEnabled &&
    acknowledgementProvider !== undefined
  ) {
    try {
      await acknowledgeCommittedInbound(
        sql,
        acknowledgementProvider,
        committedInbound,
        resolveChannelCredential,
      );
    } catch {
      /* Advisory typing failure never retries already committed ingress. */
    }
  }
}

interface FieldServiceIntakeWork {
  readonly machinePrincipalId?: string;
  readonly agentVersionId: string;
  readonly ownershipEpoch: string;
  readonly knownFields: ReturnType<typeof sanitizeIntakeProposal>;
  readonly storeOptions: readonly unknown[];
  readonly workflowPolicy: Awaited<ReturnType<typeof getServiceWorkflowPolicy>>;
  readonly conversationId: string;
  readonly contactId: string;
  readonly triggerMessageId: string;
  readonly occurredAt: string;
  readonly locale: string;
  readonly existing: Awaited<ReturnType<typeof findOpenWhatsAppServiceIntake>>;
  readonly messages: readonly {
    readonly direction: "inbound" | "outbound";
    readonly contentType: string;
    readonly text: string | null;
    readonly structuredContent: unknown;
    readonly occurredAt: string;
  }[];
}

async function finishJob(
  transaction: postgres.TransactionSql,
  job: JobRow,
  workerId: string,
): Promise<void> {
  const completed = await transaction`
    UPDATE ops.jobs SET status='succeeded', completed_at=CURRENT_TIMESTAMP,
      locked_at=NULL, locked_by=NULL, lease_expires_at=NULL, last_error_safe=NULL,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
      AND claim_token=${job.claim_token}::uuid AND lease_expires_at>clock_timestamp()
  `;
  if (completed.count !== 1)
    throw new WhatsAppProviderError("stale_worker_claim", false);
}

async function cancelJobForDisabledFeature(
  transaction: postgres.TransactionSql,
  job: JobRow,
  workerId: string,
  reason = "field_service_disabled",
): Promise<void> {
  const cancelled = await transaction`
    UPDATE ops.jobs SET status='cancelled', completed_at=CURRENT_TIMESTAMP,
      locked_at=NULL, locked_by=NULL, lease_expires_at=NULL,
      last_error_safe=${reason}, updated_at=CURRENT_TIMESTAMP
    WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
      AND claim_token=${job.claim_token}::uuid AND lease_expires_at>clock_timestamp()
  `;
  if (cancelled.count !== 1)
    throw new WhatsAppProviderError("stale_worker_claim", false);
}

async function loadFieldServiceIntakeWork(
  sql: Sql,
  workerId: string,
  job: JobRow,
): Promise<FieldServiceIntakeWork | undefined> {
  const payload = record(job.payload);
  const conversationId = payload.conversationId;
  const contactId = payload.contactId;
  const triggerMessageId = payload.triggerMessageId;
  if (
    !uuid(conversationId) ||
    !uuid(contactId) ||
    !uuid(triggerMessageId) ||
    triggerMessageId !== job.reference_id
  )
    throw new TypeError("invalid field-service intake job payload");
  return withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job);
    await requireTenantFeatures(transaction, ["field_service", "whatsapp"]);
    const feature = await getFieldServiceFeatureState(transaction);
    if (!feature.effective || !feature.whatsAppIntakeEnabled) {
      await cancelJobForDisabledFeature(transaction, job, workerId);
      return undefined;
    }
    const workflowPolicy = await getServiceWorkflowPolicy(transaction);
    if (workflowPolicy.whatsappFollowUp?.mode === "form") {
      await cancelJobForDisabledFeature(
        transaction,
        job,
        workerId,
        "digital_form_phone_first",
      );
      return undefined;
    }
    const context = await transaction<
      {
        locale: string;
        occurred_at: Date;
        contact_id: string;
        agent_version_id: string;
        ownership_epoch: string;
        known_context: { knownFields: unknown; storeOptions: unknown[] };
      }[]
    >`
      SELECT coalesce(platform.current_voice_tenant_support_profile()->>'locale', 'en') AS locale,
             message.created_at AS occurred_at,
             conversation.contact_id,conversation.ai_agent_profile_version_id AS agent_version_id,conversation.ownership_epoch,service.contact_intake_context(conversation.contact_id) AS known_context
      FROM messaging.messages message
      JOIN messaging.conversations conversation
        ON conversation.id=message.conversation_id
       AND conversation.tenant_id=message.tenant_id
      WHERE message.id=${triggerMessageId}::uuid
        AND message.conversation_id=${conversationId}::uuid
        AND conversation.contact_id=${contactId}::uuid
        AND message.direction='inbound'
        AND conversation.ownership_mode='ai' AND conversation.removed_from_inbox_at IS NULL
        AND platform.messaging_ai_actor_authorized(conversation.ai_enabled_by_user_id)
        AND EXISTS(SELECT 1 FROM agents.agent_profile_versions a WHERE a.tenant_id=conversation.tenant_id AND a.id=conversation.ai_agent_profile_version_id
          AND a.published_at IS NOT NULL AND a.validation_status='valid' AND a.tool_permissions ? 'service.intake')
    `;
    const bound = context[0];
    if (bound === undefined)
      throw new TypeError("field-service intake trigger is unavailable");
    const machine = await authorizeMachineTool(
      transaction,
      job,
      workerId,
      "service.intake",
      {
        agentVersionId: bound.agent_version_id,
        conversationId,
        contactId: bound.contact_id,
        triggerMessageId,
        ownershipEpoch: bound.ownership_epoch,
      },
    );
    const history = await transaction<
      {
        direction: "inbound" | "outbound";
        content_type: string;
        content_text: string | null;
        structured_content: unknown;
        created_at: Date;
      }[]
    >`
      SELECT direction, content_type, content_text, structured_content, created_at
      FROM messaging.messages
      WHERE conversation_id=${conversationId}::uuid
        AND direction IN ('inbound','outbound')
      ORDER BY created_at DESC, updated_at DESC, id DESC LIMIT 50
    `;
    return {
      ...(machine === null ? {} : { machinePrincipalId: machine.principalId }),
      conversationId,
      contactId: bound.contact_id,
      triggerMessageId,
      occurredAt: bound.occurred_at.toISOString(),
      locale: bound.locale,
      workflowPolicy,
      agentVersionId: bound.agent_version_id,
      ownershipEpoch: bound.ownership_epoch,
      knownFields: sanitizeIntakeProposal(bound.known_context.knownFields),
      storeOptions: bound.known_context.storeOptions,
      existing: await findOpenWhatsAppServiceIntake(
        transaction,
        conversationId,
      ),
      messages: history.toReversed().map((message) => ({
        direction: message.direction,
        contentType: message.content_type,
        text: message.content_text,
        structuredContent: message.structured_content,
        occurredAt: message.created_at.toISOString(),
      })),
    };
  });
}

async function processFieldServiceIntake(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
  openingMenuRoute?: OpeningMenuRoute,
): Promise<void> {
  try {
    const work = await loadFieldServiceIntakeWork(sql, workerId, job);
    if (work === undefined) return;
    const provider = automation.fieldServiceProvider;
    if (provider === undefined)
      throw new TypeError("field_service_ai_unavailable");
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      const machine = await authorizeMachineTool(
        transaction,
        job,
        workerId,
        "service.intake",
        work,
      );
      if (machine?.principalId !== work.machinePrincipalId)
        throw new TypeError("machine tool execution principal changed");
    });
    const extraction = await provider.extractIntake({
      locale: openingMenuRoute?.language ?? work.locale,
      workflowPolicy: work.existing?.workflowPolicy ?? work.workflowPolicy,
      existingFields: { ...work.knownFields, ...work.existing?.fields },
      storeOptions: work.storeOptions,
      intakeAlreadyOpen: work.existing !== undefined,
      messages: work.messages,
    });
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job);
      await requireTenantFeatures(transaction, ["field_service", "whatsapp"]);
      const machine = await authorizeMachineTool(
        transaction,
        job,
        workerId,
        "service.intake",
        work,
      );
      if (machine?.principalId !== work.machinePrincipalId)
        throw new TypeError("machine tool execution principal changed");
      const feature = await getFieldServiceFeatureState(transaction);
      if (!feature.effective || !feature.whatsAppIntakeEnabled) {
        await cancelJobForDisabledFeature(transaction, job, workerId);
        return;
      }
      const ownership = await transaction<
        { id: string }[]
      >`SELECT c.id FROM messaging.conversations c
        JOIN agents.agent_profile_versions a ON a.tenant_id=c.tenant_id AND a.id=c.ai_agent_profile_version_id
        WHERE c.id=${work.conversationId}::uuid AND c.ai_agent_profile_version_id=${work.agentVersionId}::uuid
          AND c.ownership_epoch=${work.ownershipEpoch}::bigint AND c.ownership_mode='ai' AND c.removed_from_inbox_at IS NULL
          AND a.published_at IS NOT NULL AND a.validation_status='valid' AND a.tool_permissions ? 'service.intake'
          AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id) FOR UPDATE OF c`;
      if (ownership.length === 0) {
        await finishJob(transaction, job, workerId);
        return;
      }
      if (await digitalServiceFormPending(transaction, work.conversationId)) {
        await cancelJobForDisabledFeature(
          transaction,
          job,
          workerId,
          "digital_form_pending",
        );
        return;
      }
      // A policy can switch while the extraction provider is running. No
      // phone-first form draft may be manufactured from that stale result.
      if (
        (await getServiceWorkflowPolicy(transaction)).whatsappFollowUp?.mode ===
        "form"
      ) {
        await cancelJobForDisabledFeature(
          transaction,
          job,
          workerId,
          "digital_form_phone_first",
        );
        return;
      }
      const current = await findOpenWhatsAppServiceIntake(
        transaction,
        work.conversationId,
      );
      if (!extraction.serviceIntent && current === undefined) {
        await finishJob(transaction, job, workerId);
        return;
      }
      const intake = await captureWhatsAppServiceIntakeMessage(transaction, {
        conversationId: work.conversationId,
        reportingContactId: work.contactId,
        messageId: work.triggerMessageId,
        occurredAt: work.occurredAt,
      });
      const { nationalId, ...safeFields } = extraction.fields;
      let protectedNationalId;
      let protectedFieldUnavailable = false;
      if (nationalId !== undefined) {
        if (automation.protectedFieldKeys === undefined) {
          protectedFieldUnavailable = true;
        } else {
          protectedNationalId = protectNationalIdWithKeys(
            job.tenant_id,
            nationalId,
            automation.protectedFieldKeys,
          );
        }
      }
      const updated = await updateWhatsAppServiceIntake(
        transaction,
        intake.id,
        safeFields,
        protectedNationalId,
      );
      if (protectedFieldUnavailable)
        await handoffWhatsAppServiceIntake(transaction, updated.id);
      const createdCase =
        !protectedFieldUnavailable &&
        extraction.confirmed &&
        updated.missingFields.length === 0
          ? await confirmWhatsAppServiceIntake(transaction, updated.id)
          : undefined;
      if (machine !== null)
        await transaction`SELECT platform.commit_machine_intake_receipt(
          ${job.id}::uuid,${workerId},${job.claim_token}::uuid,${updated.id}::uuid)`;
      await transaction`
        INSERT INTO audit.records(
          tenant_id, actor_service, action, target_type, target_id, metadata
        ) VALUES (
          platform.current_tenant_id(), 'messaging-worker', 'field_service.intake.extracted',
          'intake_draft', ${updated.id}::uuid,
          ${transaction.json({
            jobId: job.id,
            triggerMessageId: work.triggerMessageId,
            provider: provider.providerName,
            model: provider.modelName,
            confidence: extraction.confidence,
            confirmedByCustomer: extraction.confirmed,
            missingFields: updated.missingFields,
            protectedFieldUnavailable,
            caseId: createdCase?.id ?? null,
          })}
        )
      `;
      await finishJob(transaction, job, workerId);
    });
  } catch (error) {
    const reason =
      error instanceof FieldServiceAiProviderError
        ? error.code
        : error instanceof TypeError
          ? error.message
          : "field_service_intake_failed";
    const permanent =
      error instanceof TypeError ||
      (error instanceof FieldServiceAiProviderError && !error.retryable);
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent)
        await transaction`
          UPDATE ops.jobs SET max_attempts=attempts
          WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
        `;
      await transaction`
        SELECT ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${reason}, 10)
      `;
    });
  }
}

interface WhatsAppMediaWork {
  readonly ownershipEpoch: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly mediaId: string;
  readonly senderPhoneNumberId: string;
  readonly contentType: "image" | "document" | "audio" | "video";
  readonly expectedMimeType?: string;
  readonly expectedSha256?: string;
  readonly existingObjectId?: string;
}

async function loadWhatsAppMediaWork(
  sql: Sql,
  workerId: string,
  job: JobRow,
  realWhatsAppEnabled: boolean,
): Promise<WhatsAppMediaWork | undefined> {
  const payload = record(job.payload);
  const conversationId = payload.conversationId;
  const messageId = payload.messageId;
  const mediaId = payload.mediaId;
  const contentType = payload.contentType;
  if (
    !uuid(conversationId) ||
    !uuid(messageId) ||
    messageId !== job.reference_id ||
    typeof mediaId !== "string" ||
    mediaId.length < 1 ||
    mediaId.length > 500 ||
    (contentType !== "image" &&
      contentType !== "document" &&
      contentType !== "audio" &&
      contentType !== "video")
  )
    throw new TypeError("invalid WhatsApp media job payload");
  return withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job);
    if (!realWhatsAppEnabled) {
      await cancelJobForDisabledFeature(
        transaction,
        job,
        workerId,
        "whatsapp_provider_disabled",
      );
      await transaction`
        UPDATE messaging.messages SET
          structured_content=jsonb_set(
            coalesce(structured_content, '{}'::jsonb) - 'retrievalError',
            '{retrievalStatus}', '"unavailable"'::jsonb, true),
          updated_at=CURRENT_TIMESTAMP
        WHERE id=${messageId}::uuid AND object_id IS NULL
      `;
      return undefined;
    }
    const rows = await transaction<
      {
        id: string;
        object_id: string | null;
        object_status: string | null;
        provider_media_id: string | null;
        expected_mime_type: string | null;
        expected_sha256: string | null;
        sender_phone_number_id: string | null;
        ownership_epoch: string;
      }[]
    >`
      SELECT message.id, message.object_id, object.status AS object_status,
             message.structured_content->>'providerMediaId' AS provider_media_id,
             message.structured_content->>'mimeType' AS expected_mime_type,
             message.structured_content->>'sha256' AS expected_sha256,
             channel.provider_account_id AS sender_phone_number_id,
             conversation.ownership_epoch::text AS ownership_epoch
      FROM messaging.messages message
      JOIN messaging.conversations conversation
        ON conversation.id=message.conversation_id
       AND conversation.tenant_id=message.tenant_id
      JOIN messaging.channels channel
        ON channel.id=conversation.channel_id AND channel.tenant_id=message.tenant_id
      LEFT JOIN objects.object_metadata object
        ON object.id=message.object_id AND object.tenant_id=message.tenant_id
      WHERE message.id=${messageId}::uuid
        AND message.conversation_id=${conversationId}::uuid
        AND message.direction='inbound' AND message.provider='meta'
        AND message.content_type=${contentType} AND channel.provider='meta'
        AND channel.status='active' AND channel.mirror_inbound_media
      FOR UPDATE OF message
    `;
    const row = rows[0];
    if (row === undefined)
      throw new WhatsAppProviderError("media_eligibility_changed", false);
    if (row.sender_phone_number_id === null)
      throw new WhatsAppProviderError("media_eligibility_changed", false);
    if (row.provider_media_id !== mediaId)
      throw new TypeError("WhatsApp media source is unavailable");
    if (row.object_id !== null) {
      if (row.object_status !== "available")
        throw new TypeError("WhatsApp media object is unavailable");
      await transaction`
        UPDATE messaging.messages SET
          structured_content=jsonb_set(
            coalesce(structured_content, '{}'::jsonb) - 'retrievalError',
            '{retrievalStatus}', '"available"'::jsonb, true),
          updated_at=CURRENT_TIMESTAMP
        WHERE id=${messageId}::uuid
      `;
      return {
        conversationId,
        messageId,
        mediaId,
        senderPhoneNumberId: row.sender_phone_number_id,
        contentType,
        existingObjectId: row.object_id,
        ownershipEpoch: row.ownership_epoch,
      };
    }
    await transaction`
      UPDATE messaging.messages SET
        structured_content=jsonb_set(
          coalesce(structured_content, '{}'::jsonb) - 'retrievalError',
          '{retrievalStatus}', '"processing"'::jsonb, true),
        updated_at=CURRENT_TIMESTAMP
      WHERE id=${messageId}::uuid
    `;
    return {
      conversationId,
      messageId,
      mediaId,
      senderPhoneNumberId: row.sender_phone_number_id,
      ownershipEpoch: row.ownership_epoch,
      contentType,
      ...(row.expected_mime_type === null
        ? {}
        : { expectedMimeType: row.expected_mime_type }),
      ...(row.expected_sha256 === null
        ? {}
        : { expectedSha256: row.expected_sha256 }),
    };
  });
}

async function linkWhatsAppMediaToFieldService(
  sql: Sql,
  workerId: string,
  job: JobRow,
  work: WhatsAppMediaWork,
  objectId: string,
): Promise<void> {
  if (work.contentType === "audio" || work.contentType === "video") return;
  await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job);
    if (await digitalServiceFormPending(transaction, work.conversationId))
      return;
    if (!(await whatsappMediaFieldServiceProjectionEnabled(transaction)))
      return;
    await transaction`
      INSERT INTO service.report_attachments(
        tenant_id, case_id, message_id, object_id, category, source,
        processing_status, created_by_user_id
      )
      SELECT platform.current_tenant_id(), service_case.id, ${work.messageId}::uuid,
             ${objectId}::uuid,
             ${work.contentType === "image" ? "customer_photo" : "document"},
             'customer', 'available', NULL
      FROM service.intake_messages intake_message
      JOIN service.intake_drafts intake
        ON intake.id=intake_message.intake_draft_id
       AND intake.tenant_id=intake_message.tenant_id
      JOIN service.cases service_case
        ON service_case.intake_draft_id=intake.id
       AND service_case.tenant_id=intake.tenant_id
      WHERE intake_message.message_id=${work.messageId}::uuid
      ON CONFLICT (tenant_id, object_id, case_id) DO NOTHING
    `;
  });
}

/** Re-read optional-module state immediately before its derived side effect. */
export async function whatsappMediaFieldServiceProjectionEnabled(
  sql: postgres.TransactionSql,
): Promise<boolean> {
  const feature = await getFieldServiceFeatureState(sql);
  return feature.effective && feature.whatsAppIntakeEnabled;
}

async function finishWhatsAppMediaJob(
  sql: Sql,
  workerId: string,
  job: JobRow,
): Promise<void> {
  await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job);
    await finishJob(transaction, job, workerId);
  });
}

async function queueAudioTranscription(
  sql: Sql,
  workerId: string,
  job: JobRow,
  work: WhatsAppMediaWork,
  objectId: string,
): Promise<void> {
  if (work.contentType !== "audio") return;
  await withOwnedJobTransaction(sql, workerId, job, async (tx) => {
    await setTenantContext(tx, job.tenant_id);
    if (
      !(await remediationEnabled(tx, "audio_transcription")) ||
      !(await remediationEnabled(tx, "no_silence"))
    ) {
      await tx`UPDATE messaging.messages SET structured_content=coalesce(structured_content,'{}'::jsonb)||
        '{"transcriptionStatus":"disabled"}'::jsonb WHERE id=${work.messageId}::uuid`;
      return;
    }
    await tx`INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority)
      SELECT platform.current_tenant_id(),'messaging','whatsapp.audio.transcribe','conversation',${work.conversationId}::uuid,
        jsonb_build_object('operationId',${randomUUID()}::uuid,'messageId',${work.messageId}::uuid,
          'triggerMessageId',${work.messageId}::uuid,'objectId',o.id,'sha256',o.checksum),
        ${`whatsapp:audio:${work.messageId}`},20,100
      FROM objects.object_metadata o WHERE o.id=${objectId}::uuid AND o.owner_type='message'
        AND o.owner_id=${work.messageId}::uuid AND o.status='available'
      ON CONFLICT DO NOTHING`;
    await tx`UPDATE messaging.messages SET structured_content=coalesce(structured_content,'{}'::jsonb)||
      '{"transcriptionStatus":"pending"}'::jsonb WHERE id=${work.messageId}::uuid AND EXISTS(
        SELECT 1 FROM ops.jobs WHERE tenant_id=platform.current_tenant_id()
          AND idempotency_key=${`whatsapp:audio:${work.messageId}`} AND status IN ('queued','running','retry'))`;
  });
}

async function processAudioTranscription(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
): Promise<void> {
  const payload = record(job.payload);
  if (
    !uuid(payload.operationId) ||
    !uuid(payload.messageId) ||
    !uuid(payload.objectId) ||
    typeof payload.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.sha256)
  )
    throw new TypeError("invalid audio transcription job binding");
  const binding: AudioWorkBinding = {
    tenantId: job.tenant_id,
    jobId: job.id,
    claimToken: job.claim_token,
    operationId: payload.operationId,
    messageId: payload.messageId,
    objectId: payload.objectId,
    sha256: payload.sha256,
  };
  const work = await loadAiWork(sql, workerId, job);
  const ownedTransaction = async <T>(
    run: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> =>
    withOwnedJobTransaction(sql, workerId, job, async (tx) => {
      await setTenantContext(tx, job.tenant_id);
      await requireTenantFeatures(tx, ["whatsapp"]);
      await requireAiTurnOwnership(tx, work);
      if (
        !automation.realWhatsAppEnabled ||
        !(await remediationEnabled(tx, "audio_transcription")) ||
        !(await remediationEnabled(tx, "no_silence"))
      )
        throw new TypeError("audio transcription authorization changed");
      return run(tx);
    });
  const outcome = await runAudioTranscriptionWork(binding, {
    ...(automation.audioTranscriber === undefined
      ? {}
      : { transcriber: automation.audioTranscriber }),
    ownedTransaction: async (_, run) =>
      ownedTransaction((tx) =>
        run(
          createAudioWorkTransaction(tx, binding, {
            publishTranscript: async (tx, _, text) => {
              const changed =
                await tx`UPDATE messaging.messages SET content_text=${text},
          structured_content=coalesce(structured_content,'{}'::jsonb)||'{"transcriptionStatus":"completed"}'::jsonb,
          updated_at=CURRENT_TIMESTAMP WHERE id=${binding.messageId}::uuid AND object_id=${binding.objectId}::uuid
            AND conversation_id=${work.conversationId}::uuid AND direction='inbound' AND content_type='audio'`;
              if (changed.count !== 1)
                throw new TypeError("audio transcript message binding changed");
              await tx`INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority)
          VALUES(platform.current_tenant_id(),'messaging','whatsapp.ai.reply','conversation',${work.conversationId}::uuid,
            jsonb_build_object('conversationId',${work.conversationId}::uuid,'triggerMessageId',${binding.messageId}::uuid),
            ${`whatsapp-ai-audio:${binding.operationId}`},3,100) ON CONFLICT DO NOTHING`;
              if (automation.fieldServiceProvider !== undefined)
                await tx`
          INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority)
          SELECT platform.current_tenant_id(),'messaging','field_service.intake.extract','message',${binding.messageId}::uuid,
            jsonb_build_object('conversationId',${work.conversationId}::uuid,'contactId',${work.contactId}::uuid,
              'triggerMessageId',${binding.messageId}::uuid),${`field-service:intake:${binding.messageId}`},4,
            CASE WHEN EXISTS(SELECT 1 FROM platform.tenant_remediation_flags
              WHERE tenant_id=platform.current_tenant_id() AND flag_key='queue_priority' AND enabled)
              THEN 10 ELSE 20 END
          FROM platform.tenant_feature_entitlements e JOIN service.tenant_configuration c ON c.tenant_id=e.tenant_id
          WHERE e.tenant_id=platform.current_tenant_id() AND e.feature_key='field_service' AND e.available
            AND c.enabled AND c.whatsapp_intake_enabled
            AND service.current_workflow_policy()#>>'{whatsappFollowUp,mode}' IS DISTINCT FROM 'form'
            AND EXISTS(SELECT 1 FROM agents.agent_profile_versions a WHERE a.id=${work.agentVersionId}::uuid
              AND a.tenant_id=e.tenant_id AND a.published_at IS NOT NULL AND a.validation_status='valid'
              AND a.tool_permissions ? 'service.intake') ON CONFLICT DO NOTHING`;
              await tx`INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority)
          VALUES(platform.current_tenant_id(),'messaging','support.postcall.reply','conversation',${work.conversationId}::uuid,
            jsonb_build_object('conversationId',${work.conversationId}::uuid,'messageId',${binding.messageId}::uuid),
            ${`postcall:audio:${binding.operationId}`},4,40) ON CONFLICT DO NOTHING`;
            },
            ensureFallbackTaskAndAlert: async (tx, _, code) => {
              if (
                !(await queueModelFailureRecovery(
                  sql,
                  workerId,
                  job,
                  work,
                  automation,
                  { transaction: tx, finish: false },
                ))
              )
                throw new Error("audio fallback recovery unavailable");
              await tx`UPDATE messaging.messages SET structured_content=coalesce(structured_content,'{}'::jsonb)||
          ${tx.json({ transcriptionStatus: "failed", transcriptionError: code })}::jsonb WHERE id=${binding.messageId}::uuid`;
            },
          }),
        ),
      ),
    readPrivateAudio: async () => {
      const object = await ownedTransaction(
        (tx) => tx<
          {
            storage_key: string;
            content_type: string;
            byte_size: number | string;
            checksum: string;
          }[]
        >`
        SELECT storage_key,content_type,byte_size,checksum FROM objects.object_metadata
        WHERE id=${binding.objectId}::uuid AND owner_type='message' AND owner_id=${binding.messageId}::uuid
          AND checksum=${binding.sha256} AND status='available'`,
      );
      if (!object[0])
        throw new TypeError("audio private object authorization changed");
      return {
        bytes: await readPrivateObject(
          object[0].storage_key,
          {
            byteSize: Number(object[0].byte_size),
            checksum: object[0].checksum,
          },
          automation.privateObjectStorage,
        ),
        mimeType: object[0].content_type,
      };
    },
  });
  await ownedTransaction(async (tx) => {
    if (outcome.kind === "rescheduled") {
      const updated =
        await tx`UPDATE ops.jobs SET status='queued',available_at=${new Date(outcome.availableAt)},
        locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE id=${job.id}::uuid AND claim_token=${job.claim_token}::uuid AND status='running'`;
      if (updated.count !== 1)
        throw new Error("audio transcription claim lost during reschedule");
    } else await finishJob(tx, job, workerId);
  });
}

async function revalidateWhatsAppMediaAttempt(
  sql: Sql,
  workerId: string,
  job: JobRow,
  work: WhatsAppMediaWork,
  realWhatsAppEnabled: boolean,
): Promise<void> {
  await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job);
    if (!realWhatsAppEnabled)
      throw new WhatsAppProviderError("provider_disabled", false);
    const rows = await transaction<{ id: string }[]>`
      SELECT message.id FROM messaging.messages message
      JOIN messaging.conversations conversation
        ON conversation.id=message.conversation_id
       AND conversation.tenant_id=message.tenant_id
      JOIN messaging.channels channel
        ON channel.id=conversation.channel_id AND channel.tenant_id=message.tenant_id
      WHERE message.id=${work.messageId}::uuid
        AND message.conversation_id=${work.conversationId}::uuid
        AND message.object_id IS NULL AND message.provider='meta'
        AND channel.provider='meta' AND channel.status='active'
        AND channel.provider_account_id=${work.senderPhoneNumberId}
        AND channel.mirror_inbound_media
        AND conversation.ownership_epoch=${work.ownershipEpoch}::bigint
        AND conversation.removed_from_inbox_at IS NULL
        AND message.status='received' AND message.content_type=${work.contentType}
        AND message.structured_content->>'providerMediaId'=${work.mediaId}
        AND platform.messaging_media_channel_credential(
          ${job.id}::uuid,${workerId},${job.claim_token}::uuid,${work.ownershipEpoch}::bigint) IS NOT NULL
    `;
    if (rows[0] === undefined)
      throw new WhatsAppProviderError("media_eligibility_changed", false);
  });
}

async function processWhatsAppMedia(
  sql: Sql,
  workerId: string,
  job: JobRow,
  providers: Readonly<Record<"simulator" | "meta", WhatsAppProvider>>,
  automation: MessagingAutomationOptions,
): Promise<void> {
  let staged: StagedPrivateObject | undefined;
  let committed = false;
  let persisted = false;
  try {
    const realWhatsAppEnabled = automation.realWhatsAppEnabled === true;
    const work = await loadWhatsAppMediaWork(
      sql,
      workerId,
      job,
      realWhatsAppEnabled,
    );
    if (work === undefined) return;
    if (work.existingObjectId !== undefined) {
      await linkWhatsAppMediaToFieldService(
        sql,
        workerId,
        job,
        work,
        work.existingObjectId,
      );
      await queueAudioTranscription(
        sql,
        workerId,
        job,
        work,
        work.existingObjectId,
      );
      await finishWhatsAppMediaJob(sql, workerId, job);
      return;
    }
    const metaProvider = providers.meta;
    if (metaProvider.downloadMedia === undefined)
      throw new WhatsAppProviderError("media_provider_unavailable", false);
    const media = await metaProvider.downloadMedia({
      accessTokenForAttempt: async () => {
        await revalidateWhatsAppMediaAttempt(
          sql,
          workerId,
          job,
          work,
          realWhatsAppEnabled,
        );
        return withOwnedJobTransaction(
          sql,
          workerId,
          job,
          async (transaction) => {
            await setTenantContext(transaction, job.tenant_id);
            await requireOwnedJob(transaction, workerId, job);
            const projected = await transaction<
              {
                envelope: ChannelCredentialEnvelope | { legacy: true } | null;
              }[]
            >`
            SELECT platform.messaging_media_channel_credential(${job.id}::uuid,${workerId},${job.claim_token}::uuid,${work.ownershipEpoch}::bigint) AS envelope`;
            const envelope = projected[0]?.envelope;
            if (envelope === null || envelope === undefined)
              throw new WhatsAppProviderError(
                "channel_credential_unavailable",
                false,
              );
            if ("legacy" in envelope) return undefined;
            if (automation.resolveChannelCredential === undefined)
              throw new WhatsAppProviderError(
                "channel_credential_unavailable",
                false,
              );
            try {
              return automation.resolveChannelCredential(envelope);
            } catch {
              throw new WhatsAppProviderError(
                "channel_credential_unavailable",
                false,
              );
            }
          },
        );
      },
      mediaId: work.mediaId,
      senderPhoneNumberId: work.senderPhoneNumberId,
      ...(work.expectedMimeType === undefined
        ? {}
        : { expectedMimeType: work.expectedMimeType }),
      ...(work.expectedSha256 === undefined
        ? {}
        : { expectedSha256: work.expectedSha256 }),
      beforeAttempt: () =>
        revalidateWhatsAppMediaAttempt(
          sql,
          workerId,
          job,
          work,
          realWhatsAppEnabled,
        ),
    });
    const allowedMime: Readonly<
      Record<WhatsAppMediaWork["contentType"], readonly string[]>
    > = {
      image: ["image/jpeg", "image/png", "image/webp"],
      document: ["application/pdf"],
      audio: ["audio/ogg", "audio/wav"],
      video: ["video/mp4"],
    };
    if (!allowedMime[work.contentType].includes(media.contentType))
      throw new WhatsAppProviderError("media_content_type_mismatch", false);
    staged = await stagePrivateObject(
      {
        tenantId: job.tenant_id,
        caseId: work.conversationId,
        category: "whatsapp_media",
        scope: "messaging",
        declaredContentType: media.contentType,
        bytes: media.bytes,
      },
      automation.privateObjectStorage,
    );
    if (staged.checksum !== media.sha256)
      throw new TypeError("WhatsApp media checksum changed");
    await commitPrivateObject(staged);
    committed = true;
    const objectId = await withOwnedJobTransaction(
      sql,
      workerId,
      job,
      async (transaction) => {
        await setTenantContext(transaction, job.tenant_id);
        await requireOwnedJob(transaction, workerId, job);
        const eligible = await transaction<{ id: string }[]>`
        SELECT message.id FROM messaging.messages message
        JOIN messaging.conversations conversation
          ON conversation.id=message.conversation_id
         AND conversation.tenant_id=message.tenant_id
        JOIN messaging.channels channel
          ON channel.id=conversation.channel_id
         AND channel.tenant_id=message.tenant_id
        WHERE message.id=${work.messageId}::uuid
          AND message.conversation_id=${work.conversationId}::uuid
          AND message.object_id IS NULL AND message.provider='meta'
          AND channel.provider='meta' AND channel.status='active'
          AND channel.provider_account_id=${work.senderPhoneNumberId}
          AND channel.mirror_inbound_media
          AND conversation.ownership_epoch=${work.ownershipEpoch}::bigint
          AND conversation.removed_from_inbox_at IS NULL
          AND message.status='received' AND message.content_type=${work.contentType}
          AND message.structured_content->>'providerMediaId'=${work.mediaId}
          AND platform.authorize_media_commit(
            ${job.id}::uuid,${workerId},${job.claim_token}::uuid,
            ${work.ownershipEpoch}::bigint,${work.senderPhoneNumberId})
        FOR UPDATE OF message
      `;
        if (!realWhatsAppEnabled || eligible[0] === undefined) {
          await cancelJobForDisabledFeature(
            transaction,
            job,
            workerId,
            "whatsapp_media_disabled",
          );
          await transaction`
          UPDATE messaging.messages SET
            structured_content=jsonb_set(
              coalesce(structured_content, '{}'::jsonb) - 'retrievalError',
              '{retrievalStatus}', '"unavailable"'::jsonb, true),
            updated_at=CURRENT_TIMESTAMP
          WHERE id=${work.messageId}::uuid AND object_id IS NULL
        `;
          return null;
        }
        const objects = await transaction<{ id: string }[]>`
        INSERT INTO objects.object_metadata(
          tenant_id, created_by_user_id, owner_type, owner_id, category,
          content_type, byte_size, checksum, storage_backend, storage_key, status
        ) VALUES (
          platform.current_tenant_id(), NULL, 'message', ${work.messageId}::uuid,
          ${work.contentType === "image" ? "whatsapp_customer_image" : work.contentType === "audio" ? "whatsapp_customer_audio" : work.contentType === "video" ? "whatsapp_customer_video" : "whatsapp_customer_document"},
          ${staged?.contentType ?? media.contentType},
          ${staged?.byteSize ?? media.bytes.byteLength},
          ${staged?.checksum ?? media.sha256}, 'local',
          ${staged?.storageKey ?? ""}, 'available'
        ) RETURNING id
      `;
        const objectId = objects[0]?.id;
        if (objectId === undefined)
          throw new Error("WhatsApp media object creation failed");
        const updated = await transaction<{ id: string }[]>`
        UPDATE messaging.messages SET object_id=${objectId}::uuid,
          structured_content=jsonb_set(
            coalesce(structured_content, '{}'::jsonb) - 'retrievalError',
            '{retrievalStatus}', '"available"'::jsonb, true),
          updated_at=CURRENT_TIMESTAMP
        WHERE id=${work.messageId}::uuid AND object_id IS NULL
        RETURNING id
      `;
        if (updated[0] === undefined)
          throw new TypeError(
            "WhatsApp media message changed during retrieval",
          );
        return objectId;
      },
    );
    if (objectId === null) {
      await discardPrivateObject(staged);
      return;
    }
    persisted = true;
    await linkWhatsAppMediaToFieldService(sql, workerId, job, work, objectId);
    await queueAudioTranscription(sql, workerId, job, work, objectId);
    await finishWhatsAppMediaJob(sql, workerId, job);
  } catch (error) {
    if (staged !== undefined && !persisted)
      await discardPrivateObject(staged).catch(() => undefined);
    if (
      error instanceof WhatsAppProviderError &&
      error.code === "stale_worker_claim"
    )
      return;
    const reason =
      error instanceof WhatsAppProviderError
        ? error.code
        : error instanceof TypeError
          ? error.message
          : committed
            ? "whatsapp_media_persistence_failed"
            : "whatsapp_media_retrieval_failed";
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      const owned = await transaction<{ id: string }[]>`
        SELECT id FROM ops.jobs WHERE id=${job.id}::uuid
          AND status='running' AND locked_by=${workerId} FOR UPDATE
      `;
      if (owned[0] === undefined) return;
      if (
        reason === "provider_disabled" ||
        reason === "media_eligibility_changed"
      ) {
        await cancelJobForDisabledFeature(
          transaction,
          job,
          workerId,
          reason === "provider_disabled"
            ? "whatsapp_provider_disabled"
            : "whatsapp_media_disabled",
        );
        if (job.reference_id !== null)
          await transaction`
            UPDATE messaging.messages SET
              structured_content=jsonb_set(
                coalesce(structured_content, '{}'::jsonb) - 'retrievalError',
                '{retrievalStatus}', '"unavailable"'::jsonb, true),
              updated_at=CURRENT_TIMESTAMP
            WHERE id=${job.reference_id}::uuid AND object_id IS NULL
          `;
        return;
      }
      const retryable =
        error instanceof WhatsAppProviderError && error.retryable;
      if (!retryable)
        await transaction`
          UPDATE ops.jobs SET max_attempts=attempts
          WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
        `;
      const failed = await transaction<{ status: string }[]>`
        SELECT (ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${reason}, 15)).status
      `;
      if (job.reference_id !== null) {
        const finalFailure = failed[0]?.status === "dead";
        await transaction`
          UPDATE messaging.messages SET
            structured_content=jsonb_set(
              jsonb_set(coalesce(structured_content, '{}'::jsonb),
                '{retrievalStatus}',
                ${finalFailure ? '"failed"' : '"pending"'}::text::jsonb, true),
              '{retrievalError}',
              ${finalFailure ? JSON.stringify(reason) : "null"}::text::jsonb, true),
            updated_at=CURRENT_TIMESTAMP
          WHERE id=${job.reference_id}::uuid AND object_id IS NULL
        `;
      }
    });
  }
}

interface FieldServiceOcrWork {
  readonly ocrResultId: string;
  readonly attachmentId: string;
  readonly objectId: string;
  readonly contentType: "image/jpeg" | "image/png" | "image/webp";
  readonly byteSize: number;
  readonly checksum: string;
  readonly storageKey: string;
  readonly originatingActorId: string;
}

interface FieldServiceSummaryWork {
  readonly summaryId: string;
  readonly caseId: string;
  readonly sourceKind: "whatsapp" | "call";
  readonly sourceReferenceId: string;
  readonly locale: string;
  readonly checksum: string;
  readonly evidence?: string;
  readonly transcript?: {
    readonly storageKey: string;
    readonly byteSize: number;
  };
}

function redactSummaryEvidence(value: string): string {
  return value
    .replace(
      /(?<![0-9])(?:[0-9][ -]?){7,10}(?![0-9])/gu,
      "[sensitive-id-redacted]",
    )
    .replace(/\s+/gu, " ")
    .trim();
}

async function whatsappSummarySource(
  transaction: postgres.TransactionSql,
  caseId: string,
  conversationId: string,
): Promise<
  { readonly checksum: string; readonly evidence: string } | undefined
> {
  const messages = await transaction<
    {
      id: string;
      direction: "inbound" | "outbound";
      sender_type: string;
      content_type: string;
      content_text: string | null;
      created_at: Date;
    }[]
  >`
    SELECT message.id, message.direction, message.sender_type,
           message.content_type, message.content_text, message.created_at
    FROM service.case_conversations link
    JOIN messaging.messages message
      ON message.tenant_id=link.tenant_id
     AND message.conversation_id=link.conversation_id
    WHERE link.case_id=${caseId}::uuid
      AND link.conversation_id=${conversationId}::uuid
    ORDER BY message.created_at, message.updated_at, message.id
  `;
  if (messages.length === 0) return undefined;
  const checksum = factDigest(
    JSON.stringify(
      messages.map((message) => [
        message.id,
        message.direction,
        message.sender_type,
        message.content_type,
        message.content_text,
        message.created_at.toISOString(),
      ]),
    ),
  );
  const bounded = messages.slice(-250);
  const lines = bounded.map((message) => {
    const content =
      message.content_text === null
        ? `[${message.content_type} attachment retained]`
        : redactSummaryEvidence(message.content_text).slice(0, 2_000);
    return `${message.created_at.toISOString()} · ${message.direction === "inbound" ? "Customer/reporting contact" : "CRM/AI agent"}: ${content}`;
  });
  return {
    checksum,
    evidence: [
      ...(messages.length > bounded.length
        ? [
            `[${String(messages.length - bounded.length)} earlier messages omitted from the AI input; they remain retained in the dossier]`,
          ]
        : []),
      ...lines,
    ]
      .join("\n")
      .slice(-80_000),
  };
}

async function loadFieldServiceSummaryWork(
  sql: Sql,
  workerId: string,
  job: JobRow,
): Promise<FieldServiceSummaryWork | undefined> {
  const payload = record(job.payload);
  const summaryId = payload.summaryId;
  const caseId = payload.caseId;
  const sourceKind = payload.sourceKind;
  const sourceReferenceId = payload.sourceReferenceId;
  if (
    !uuid(summaryId) ||
    !uuid(caseId) ||
    !uuid(sourceReferenceId) ||
    summaryId !== job.reference_id ||
    (sourceKind !== "whatsapp" && sourceKind !== "call")
  )
    throw new TypeError("invalid field-service summary job payload");
  return withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job);
    await requireTenantFeatures(transaction, ["field_service"]);
    const feature = await getFieldServiceFeatureState(transaction);
    if (!feature.effective) {
      await transaction`
        UPDATE service.case_summaries SET status='failed',
          error_safe='field_service_disabled', completed_at=CURRENT_TIMESTAMP
        WHERE id=${summaryId}::uuid AND status IN ('pending','processing')
      `;
      await cancelJobForDisabledFeature(transaction, job, workerId);
      return undefined;
    }
    await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended(
        platform.current_tenant_id()::text || ':case-summary:' || ${summaryId}, 0
      ))
    `;
    const summary = await transaction<
      { status: string; source_kind: string; source_reference_id: string }[]
    >`
      SELECT status, source_kind, source_reference_id
      FROM service.case_summaries
      WHERE id=${summaryId}::uuid AND case_id=${caseId}::uuid
        AND source_kind=${sourceKind}
        AND source_reference_id=${sourceReferenceId}::uuid
      FOR UPDATE
    `;
    if (summary[0] === undefined)
      throw new TypeError("field-service summary source is unavailable");
    if (summary[0].status === "completed") {
      await finishJob(transaction, job, workerId);
      return undefined;
    }
    const locale = await transaction<{ locale: string }[]>`
      SELECT coalesce(settings.locale, 'en') AS locale
      FROM public.tenants tenant
      LEFT JOIN crm.tenant_settings settings ON settings.tenant_id=tenant.id
      WHERE tenant.id=platform.current_tenant_id()
    `;
    if (sourceKind === "whatsapp") {
      const source = await whatsappSummarySource(
        transaction,
        caseId,
        sourceReferenceId,
      );
      if (source === undefined) {
        await transaction`
          UPDATE service.case_summaries SET status='unavailable',
            error_safe='whatsapp_history_unavailable', completed_at=CURRENT_TIMESTAMP
          WHERE id=${summaryId}::uuid
        `;
        await finishJob(transaction, job, workerId);
        return undefined;
      }
      await transaction`
        UPDATE service.case_summaries SET status='processing',
          source_checksum=${source.checksum}, error_safe=NULL, completed_at=NULL
        WHERE id=${summaryId}::uuid
      `;
      return {
        summaryId,
        caseId,
        sourceKind,
        sourceReferenceId,
        locale: locale[0]?.locale ?? "en",
        checksum: source.checksum,
        evidence: source.evidence,
      };
    }
    const transcript = await transaction<
      {
        checksum: string;
        storage_backend: string;
        storage_key: string;
        byte_size: string;
        status: string;
      }[]
    >`
      SELECT object.checksum, object.storage_backend, object.storage_key,
             object.byte_size, object.status
      FROM service.case_calls link
      JOIN public.sessions session
        ON session.tenant_id=link.tenant_id AND session.session_id=link.session_id
      JOIN objects.object_metadata object
        ON object.tenant_id=session.tenant_id AND object.id=session.transcript_object_id
      WHERE link.case_id=${caseId}::uuid AND link.session_id=${sourceReferenceId}::uuid
        AND object.deleted_at IS NULL
    `;
    const source = transcript[0];
    if (source?.status !== "available" || source.storage_backend !== "local") {
      await transaction`
        UPDATE service.case_summaries SET status='unavailable',
          error_safe='call_transcript_unavailable', completed_at=CURRENT_TIMESTAMP
        WHERE id=${summaryId}::uuid
      `;
      await finishJob(transaction, job, workerId);
      return undefined;
    }
    await transaction`
      UPDATE service.case_summaries SET status='processing',
        source_checksum=${source.checksum}, error_safe=NULL, completed_at=NULL
      WHERE id=${summaryId}::uuid
    `;
    return {
      summaryId,
      caseId,
      sourceKind,
      sourceReferenceId,
      locale: locale[0]?.locale ?? "en",
      checksum: source.checksum,
      transcript: {
        storageKey: source.storage_key,
        byteSize: Number(source.byte_size),
      },
    };
  });
}

async function processFieldServiceSummary(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
): Promise<void> {
  try {
    const work = await loadFieldServiceSummaryWork(sql, workerId, job);
    if (work === undefined) return;
    const provider = automation.fieldServiceProvider;
    if (provider === undefined)
      throw new TypeError("field_service_summary_provider_unavailable");
    const evidence =
      work.evidence ??
      redactSummaryEvidence(
        Buffer.from(
          await readPrivateObject(
            work.transcript?.storageKey ?? "",
            {
              byteSize: work.transcript?.byteSize ?? 0,
              checksum: work.checksum,
            },
            automation.privateObjectStorage,
          ),
        )
          .toString("utf8")
          .slice(0, 80_000),
      );
    const mayCallProvider = await withOwnedJobTransaction(
      sql,
      workerId,
      job,
      async (transaction) => {
        await setTenantContext(transaction, job.tenant_id);
        await requireOwnedJob(transaction, workerId, job);
        await requireTenantFeatures(transaction, ["field_service"]);
        const menuAuthorization = await transaction<{ allowed: boolean }[]>`
          SELECT platform.opening_menu_business_job_allowed(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS allowed`;
        if (menuAuthorization[0]?.allowed !== true) {
          await transaction`UPDATE service.case_summaries SET status='failed',
            error_safe='opening_menu_route_denied',completed_at=clock_timestamp()
            WHERE id=${work.summaryId}::uuid AND status='processing'`;
          await cancelJobForDisabledFeature(
            transaction,
            job,
            workerId,
            "opening_menu_route_denied",
          );
          return false;
        }
        const feature = await getFieldServiceFeatureState(transaction);
        if (!feature.effective) {
          await transaction`
          UPDATE service.case_summaries SET status='failed',
            error_safe='field_service_disabled', completed_at=CURRENT_TIMESTAMP
          WHERE id=${work.summaryId}::uuid AND status='processing'
        `;
          await cancelJobForDisabledFeature(transaction, job, workerId);
          return false;
        }
        return true;
      },
    );
    if (!mayCallProvider) return;
    const summary = await provider.summarizeEvidence({
      sourceKind: work.sourceKind,
      locale: work.locale,
      evidence,
    });
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job);
      await requireTenantFeatures(transaction, ["field_service"]);
      const menuAuthorization = await transaction<{ allowed: boolean }[]>`
        SELECT platform.opening_menu_business_job_allowed(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS allowed`;
      if (menuAuthorization[0]?.allowed !== true) {
        await transaction`UPDATE service.case_summaries SET status='failed',
          error_safe='opening_menu_route_denied',completed_at=clock_timestamp()
          WHERE id=${work.summaryId}::uuid AND status='processing'`;
        await cancelJobForDisabledFeature(
          transaction,
          job,
          workerId,
          "opening_menu_route_denied",
        );
        return;
      }
      const feature = await getFieldServiceFeatureState(transaction);
      if (!feature.effective) {
        await transaction`
          UPDATE service.case_summaries SET status='failed',
            error_safe='field_service_disabled', completed_at=CURRENT_TIMESTAMP
          WHERE id=${work.summaryId}::uuid AND status='processing'
        `;
        await cancelJobForDisabledFeature(transaction, job, workerId);
        return;
      }
      const unchanged =
        work.sourceKind === "whatsapp"
          ? await whatsappSummarySource(
              transaction,
              work.caseId,
              work.sourceReferenceId,
            )
          : { checksum: work.checksum, evidence: "" };
      if (unchanged?.checksum !== work.checksum) {
        await transaction`
          UPDATE service.case_summaries SET status='pending', summary=NULL,
            source_checksum=${unchanged?.checksum ?? null}, provider=NULL,
            model=NULL, error_safe=NULL, completed_at=NULL
          WHERE id=${work.summaryId}::uuid AND status='processing'
        `;
        await finishJob(transaction, job, workerId);
        return;
      }
      const completed = await transaction<{ id: string }[]>`
        UPDATE service.case_summaries SET status='completed', summary=${summary},
          provider=${provider.providerName}, model=${provider.modelName},
          error_safe=NULL, completed_at=CURRENT_TIMESTAMP
        WHERE id=${work.summaryId}::uuid AND status='processing'
          AND source_checksum=${work.checksum}
        RETURNING id
      `;
      if (completed[0] === undefined)
        throw new TypeError("field-service summary changed during processing");
      await finishJob(transaction, job, workerId);
    });
  } catch (error) {
    const reason =
      error instanceof FieldServiceAiProviderError
        ? error.code
        : error instanceof TypeError
          ? error.message
          : "field_service_summary_failed";
    const permanent =
      error instanceof TypeError ||
      (error instanceof FieldServiceAiProviderError && !error.retryable);
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent)
        await transaction`
          UPDATE ops.jobs SET max_attempts=attempts
          WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
        `;
      const failed = await transaction<{ status: string }[]>`
        SELECT (ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${reason}, 15)).status
      `;
      if (job.reference_id !== null)
        await transaction`
          UPDATE service.case_summaries SET
            status=${failed[0]?.status === "dead" ? "failed" : "pending"},
            error_safe=${reason},
            completed_at=CASE WHEN ${failed[0]?.status === "dead"}
              THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE id=${job.reference_id}::uuid
            AND status IN ('pending','processing')
        `;
    });
  }
}

async function cancelFieldServiceOcr(
  transaction: postgres.TransactionSql,
  job: JobRow,
  workerId: string,
  reason = "field_service_disabled",
): Promise<void> {
  if (job.reference_id !== null)
    await transaction`
      UPDATE service.ocr_results SET status='failed',
        error_safe=${reason}, completed_at=CURRENT_TIMESTAMP
      WHERE id=${job.reference_id}::uuid AND status IN ('pending','processing')
    `;
  await cancelJobForDisabledFeature(transaction, job, workerId, reason);
}

async function loadFieldServiceOcrWork(
  sql: Sql,
  workerId: string,
  job: JobRow,
): Promise<FieldServiceOcrWork | undefined> {
  const payload = record(job.payload);
  const ocrResultId = payload.ocrResultId;
  const attachmentId = payload.attachmentId;
  if (
    !uuid(ocrResultId) ||
    !uuid(attachmentId) ||
    ocrResultId !== job.reference_id
  )
    throw new TypeError("invalid field-service OCR job payload");
  return withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job);
    await requireTenantFeatures(transaction, [
      "field_service",
      "documents",
      "ocr",
    ]);
    const feature = await getFieldServiceFeatureState(transaction);
    if (!feature.effective || !feature.ocrEnabled) {
      await cancelFieldServiceOcr(transaction, job, workerId);
      return undefined;
    }
    const rows = await transaction<
      {
        attachment_id: string;
        object_id: string;
        content_type: string;
        byte_size: string;
        checksum: string;
        storage_backend: string;
        storage_key: string;
        object_status: string;
        category: string;
        actor_id: string | null;
        source_checksum: string;
      }[]
    >`
      SELECT result.attachment_id, attachment.object_id, object.content_type,
             object.byte_size, object.checksum, object.storage_backend,
             object.storage_key, object.status AS object_status,
             attachment.category, attachment.created_by_user_id AS actor_id,
             result.source_checksum
      FROM service.ocr_results result
      JOIN service.report_attachments attachment
        ON attachment.id=result.attachment_id
       AND attachment.tenant_id=result.tenant_id
      JOIN objects.object_metadata object
        ON object.id=attachment.object_id AND object.tenant_id=attachment.tenant_id
      WHERE result.id=${ocrResultId}::uuid
        AND result.attachment_id=${attachmentId}::uuid
        AND result.status IN ('pending','processing')
        AND object.deleted_at IS NULL
      FOR UPDATE OF result
    `;
    const row = rows[0];
    if (row === undefined)
      throw new TypeError("field-service OCR source is unavailable");
    if (
      row.category !== "product_label" ||
      row.object_status !== "available" ||
      row.storage_backend !== "local" ||
      !["image/jpeg", "image/png", "image/webp"].includes(row.content_type)
    )
      throw new TypeError("field-service OCR source is unsupported");
    if (!uuid(row.actor_id) || row.source_checksum !== row.checksum)
      throw new TypeError(
        "field-service OCR source authorization is unavailable",
      );
    const authority = await transaction<{ allowed: boolean }[]>`
      SELECT service.ocr_origin_actor_authorized(${attachmentId}::uuid,${row.actor_id}::uuid) AS allowed`;
    if (authority[0]?.allowed !== true)
      throw new TypeError("field-service OCR originating actor unauthorized");
    await transaction`
      UPDATE service.ocr_results SET status='processing', error_safe=NULL
      WHERE id=${ocrResultId}::uuid
    `;
    return {
      ocrResultId,
      attachmentId: row.attachment_id,
      objectId: row.object_id,
      contentType: row.content_type as FieldServiceOcrWork["contentType"],
      byteSize: Number(row.byte_size),
      checksum: row.checksum,
      storageKey: row.storage_key,
      originatingActorId: row.actor_id,
    };
  });
}

async function requireCurrentOcrSource(
  transaction: postgres.TransactionSql,
  work: FieldServiceOcrWork,
): Promise<void> {
  const valid = await transaction<{ id: string }[]>`
    SELECT result.id FROM service.ocr_results result
    JOIN service.report_attachments attachment ON attachment.id=result.attachment_id AND attachment.tenant_id=result.tenant_id
    JOIN objects.object_metadata object ON object.id=attachment.object_id AND object.tenant_id=attachment.tenant_id
    WHERE result.id=${work.ocrResultId}::uuid AND result.status='processing'
      AND attachment.id=${work.attachmentId}::uuid AND attachment.created_by_user_id=${work.originatingActorId}::uuid
      AND attachment.category='product_label' AND object.id=${work.objectId}::uuid
      AND object.status='available' AND object.deleted_at IS NULL AND object.storage_backend='local'
      AND object.storage_key=${work.storageKey} AND object.content_type=${work.contentType}
      AND object.byte_size=${work.byteSize} AND object.checksum=${work.checksum}
      AND result.source_checksum=${work.checksum}
      AND service.ocr_origin_actor_authorized(attachment.id,${work.originatingActorId}::uuid)
    FOR SHARE OF result`;
  if (valid.length !== 1)
    throw new TypeError(
      "field-service OCR source or originating actor changed",
    );
}

async function processFieldServiceOcr(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
): Promise<void> {
  try {
    const work = await loadFieldServiceOcrWork(sql, workerId, job);
    if (work === undefined) return;
    const provider = automation.fieldServiceProvider;
    if (provider === undefined)
      throw new TypeError("field_service_ocr_provider_unavailable");
    const bytes = await readPrivateObject(
      work.storageKey,
      { byteSize: work.byteSize, checksum: work.checksum },
      automation.privateObjectStorage,
    );
    const mayCallProvider = await withOwnedJobTransaction(
      sql,
      workerId,
      job,
      async (transaction) => {
        await setTenantContext(transaction, job.tenant_id);
        await requireOwnedJob(transaction, workerId, job);
        await requireTenantFeatures(transaction, [
          "field_service",
          "documents",
          "ocr",
        ]);
        const feature = await getFieldServiceFeatureState(transaction);
        if (!feature.effective || !feature.ocrEnabled) {
          await cancelFieldServiceOcr(transaction, job, workerId);
          return false;
        }
        await requireCurrentOcrSource(transaction, work);
        const menu = await transaction<{ allowed: boolean }[]>`
          SELECT platform.opening_menu_business_job_allowed(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS allowed`;
        if (menu[0]?.allowed !== true) {
          await cancelFieldServiceOcr(
            transaction,
            job,
            workerId,
            "opening_menu_route_denied",
          );
          return false;
        }
        return true;
      },
    );
    if (!mayCallProvider) return;
    const extraction = await provider.extractProductLabel({
      bytes,
      contentType: work.contentType,
    });
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job);
      await requireTenantFeatures(transaction, [
        "field_service",
        "documents",
        "ocr",
      ]);
      const feature = await getFieldServiceFeatureState(transaction);
      if (!feature.effective || !feature.ocrEnabled) {
        await cancelFieldServiceOcr(transaction, job, workerId);
        return;
      }
      await requireCurrentOcrSource(transaction, work);
      const menu = await transaction<{ allowed: boolean }[]>`
        SELECT platform.opening_menu_business_job_allowed(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS allowed`;
      if (menu[0]?.allowed !== true) {
        await cancelFieldServiceOcr(
          transaction,
          job,
          workerId,
          "opening_menu_route_denied",
        );
        return;
      }
      const updated = await transaction<{ id: string }[]>`
        UPDATE service.ocr_results SET
          status='review_required', proposed_fields=${transaction.json(extraction.fields)},
          confidence=${extraction.confidence}, provider=${provider.providerName},
          model=${provider.modelName}, error_safe=NULL,
          provenance=${transaction.json({
            schemaVersion: "1.0",
            sourceObjectId: work.objectId,
            sourceChecksum: work.checksum,
            fieldConfidence: extraction.fieldConfidence,
            humanReviewRequired: true,
          })},
          completed_at=CURRENT_TIMESTAMP
        WHERE id=${work.ocrResultId}::uuid AND status='processing'
        RETURNING id
      `;
      if (updated[0] === undefined)
        throw new TypeError(
          "field-service OCR result changed during processing",
        );
      await finishJob(transaction, job, workerId);
    });
  } catch (error) {
    const reason =
      error instanceof FieldServiceAiProviderError
        ? error.code
        : error instanceof TypeError
          ? error.message
          : "field_service_ocr_failed";
    const permanent =
      error instanceof TypeError ||
      (error instanceof FieldServiceAiProviderError && !error.retryable);
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent)
        await transaction`
          UPDATE ops.jobs SET max_attempts=attempts
          WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
        `;
      const failed = await transaction<{ status: string }[]>`
        SELECT (ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${reason}, 15)).status
      `;
      const writable = await transaction<{ allowed: boolean }[]>`
        SELECT platform.current_tenant_feature_enabled('field_service')
          AND platform.current_tenant_feature_enabled('documents')
          AND platform.current_tenant_feature_enabled('ocr') AS allowed`;
      if (job.reference_id !== null && writable[0]?.allowed === true)
        await transaction`
          UPDATE service.ocr_results SET
            status=${failed[0]?.status === "dead" ? "failed" : "pending"},
            error_safe=${reason},
            completed_at=CASE WHEN ${failed[0]?.status === "dead"}
              THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE id=${job.reference_id}::uuid
            AND status IN ('pending','processing')
        `;
    });
  }
}

/**
 * The tenant's AI actor for automatic work, or nothing.
 *
 * Post-call processing runs long after the conversation that authorised it, so
 * the actor is re-resolved and re-authorised here rather than carried in a job
 * payload where a revoked operator would still look valid.
 */
async function postCallActor(
  transaction: postgres.TransactionSql,
): Promise<string | null> {
  const rows = await transaction<{ user_id: string }[]>`
    SELECT settings.whatsapp_ai_enabled_by_user_id AS user_id
    FROM crm.tenant_settings settings
    WHERE settings.tenant_id = platform.current_tenant_id()
      AND settings.whatsapp_ai_enabled_by_user_id IS NOT NULL
      AND platform.messaging_ai_actor_authorized(settings.whatsapp_ai_enabled_by_user_id)
  `;
  return rows[0]?.user_id ?? null;
}

function attemptReference(job: JobRow): string {
  const payload = record(job.payload);
  const attemptId = payload.attemptId;
  if (
    job.reference_id === null ||
    !uuid(attemptId) ||
    attemptId !== job.reference_id
  )
    throw new TypeError("post-call job reference is invalid");
  return job.reference_id;
}

/**
 * Drive one attempt's post-call workflow as far as it can go this delivery.
 *
 * Re-entrant by construction: each step asks the database to move a specific
 * stage and does nothing if it has already moved. A duplicate delivery, a
 * restarted worker and a retry after a crash therefore converge on one result
 * instead of producing a second summary, a second ticket update or a second
 * wrap-up message.
 */
async function processPostCall(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
): Promise<void> {
  try {
    const attemptId = attemptReference(job);
    const work = await withOwnedJobTransaction(
      sql,
      workerId,
      job,
      async (transaction) => {
        await setTenantContext(transaction, job.tenant_id);
        await requireOwnedJob(transaction, workerId, job);
        const loaded = await loadPostCallWork(transaction, attemptId);
        if (loaded === undefined)
          throw new TypeError("post_call_attempt_missing");
        if (
          loaded.conversationId !== null &&
          (await digitalServiceFormPending(transaction, loaded.conversationId))
        ) {
          await cancelJobForDisabledFeature(
            transaction,
            job,
            workerId,
            "digital_form_pending",
          );
          return undefined;
        }
        return loaded;
      },
    );
    if (work === undefined) return;
    if (work.stage === "complete") {
      await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
        await setTenantContext(transaction, job.tenant_id);
        await finishJob(transaction, job, workerId);
      });
      return;
    }
    if (work.sessionId === null)
      throw new TypeError("post_call_session_missing");
    const sessionId = work.sessionId;
    const callOutcome = callOutcomeFromSession(
      work.sessionStatus,
      work.sessionAnswered,
      work.sessionOutcome,
    );

    // --- Artifacts -------------------------------------------------------
    // Reading a full call out of object storage happens outside any
    // transaction; holding a connection open for an upload-sized fetch would
    // block the queue behind one slow bucket.
    let transcriptState = work.transcriptState;
    let analysable =
      work.stage !== "artifacts_pending" &&
      callOutcome === "answered" &&
      (work.transcriptState === "valid" || work.transcriptState === "partial");
    if (work.stage === "artifacts_pending") {
      if (automation.artifactVerifier === undefined)
        throw new ArtifactVerifierError("artifact_verifier_unavailable", false);
      const actorUserId = await withOwnedJobTransaction(
        sql,
        workerId,
        job,
        async (transaction) => {
          await setTenantContext(transaction, job.tenant_id);
          return postCallActor(transaction);
        },
      );
      const verified = await automation.artifactVerifier.verify({
        tenantId: job.tenant_id,
        sessionId,
        actorUserId: actorUserId ?? job.tenant_id,
        jobId: job.id,
      });
      const outcome = await withOwnedJobTransaction(
        sql,
        workerId,
        job,
        async (transaction) => {
          await setTenantContext(transaction, job.tenant_id);
          await requireOwnedJob(transaction, workerId, job);
          return recordArtifactVerification(transaction, actorUserId, {
            attemptId,
            ticketId: work.ticketId,
            sessionId,
            callOutcome,
            recording: verified.recording,
            transcript: verified.transcript,
          });
        },
      );
      transcriptState = outcome.transcriptState;
      analysable = outcome.analysable;
    }

    // --- Analysis --------------------------------------------------------
    // A missing recording never blocks this, and a missing transcript never
    // invents one: with nothing said there is nothing to summarise, and the
    // attempt says `not_applicable` rather than pretending to have failed.
    //
    // Gated on the stage, not only on whether an analysis exists: a retry that
    // arrives after a permanent analysis failure must carry on to the ticket
    // update rather than try the provider again and fail the job forever.
    let analysis = work.analysis;
    const analysisOwed =
      analysable &&
      analysis === null &&
      (work.stage === "artifacts_pending" ||
        work.stage === "artifacts_verified" ||
        work.stage === "summary_pending");
    if (
      analysisOwed &&
      // A deployment with no model configured produces no summary and says so,
      // rather than parking every finished call on a provider it will never get.
      (automation.postCallProvider === undefined ||
        automation.artifactVerifier === undefined)
    ) {
      await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
        await setTenantContext(transaction, job.tenant_id);
        await failPostCallAnalysis(transaction, {
          attemptId,
          errorSafe: "analysis_provider_unavailable",
          permanent: true,
        });
      });
    } else if (analysisOwed) {
      const provider = automation.postCallProvider;
      const verifier = automation.artifactVerifier;
      if (provider === undefined || verifier === undefined)
        throw new PostCallProviderError("analysis_provider_unavailable", false);
      const started = await withOwnedJobTransaction(
        sql,
        workerId,
        job,
        async (transaction) => {
          await setTenantContext(transaction, job.tenant_id);
          await requireOwnedJob(transaction, workerId, job);
          const begun = await beginPostCallAnalysis(transaction, attemptId);
          const actorUserId = await postCallActor(transaction);
          const evidence = await loadCallEvidence(transaction, {
            ticketId: work.ticketId,
            conversationId: work.conversationId,
            contactId: work.contactId,
          });
          return { begun, actorUserId, evidence };
        },
      );
      if (started.begun) {
        const turns = await verifier.transcript({
          tenantId: job.tenant_id,
          sessionId,
          actorUserId: started.actorUserId ?? job.tenant_id,
          jobId: job.id,
        });
        try {
          const produced = await provider.analyse({
            // The customer's own language, detected the same way every other
            // outbound reply detects it, not the tenant's default assumption.
            locale: latestMessageLocale(
              started.evidence.configuredLocale,
              started.evidence.latestInboundText,
            ),
            issueSubject: work.ticketSubject,
            callOutcome,
            turns,
            whatsAppContext: started.evidence.whatsAppContext,
            actionReceipts: started.evidence.actionReceiptIds.map((id) => ({
              id,
              kind: "platform_receipt",
              statusSafe: "recorded",
            })),
            evidence: {
              // The cited turn range is what the analysis actually saw, so an
              // index beyond it is a fabrication however plausible it looks.
              transcriptTurnCount: turns.length,
              whatsAppMessageIds: started.evidence.whatsAppMessageIds,
              actionReceiptIds: started.evidence.actionReceiptIds,
              operatorNoteIds: started.evidence.operatorNoteIds,
            },
          });
          await withOwnedJobTransaction(
            sql,
            workerId,
            job,
            async (transaction) => {
              await setTenantContext(transaction, job.tenant_id);
              await requireOwnedJob(transaction, workerId, job);
              await recordPostCallAnalysis(transaction, {
                attemptId,
                analysis: produced,
                modelSafe: automation.postCallModel ?? "configured-llm",
              });
            },
          );
          analysis = produced;
        } catch (error) {
          if (!(error instanceof PostCallProviderError)) throw error;
          // The ticket, the call and the artifacts all survive a provider
          // failure; only the summary is missing, and it says so.
          await withOwnedJobTransaction(
            sql,
            workerId,
            job,
            async (transaction) => {
              await setTenantContext(transaction, job.tenant_id);
              await failPostCallAnalysis(transaction, {
                attemptId,
                errorSafe: error.code,
                permanent: !error.retryable,
              });
            },
          );
          if (error.retryable) throw error;
          analysis = null;
        }
      }
    } else if (!analysable) {
      await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
        await setTenantContext(transaction, job.tenant_id);
        await requireOwnedJob(transaction, workerId, job);
        await skipPostCallAnalysis(transaction, attemptId);
      });
    }

    // --- The ticket, then the customer -----------------------------------
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job);
      const actorUserId = await postCallActor(transaction);
      const applied = await applyPostCallOutcome(transaction, actorUserId, {
        attemptId,
        ticketId: work.ticketId,
        analysis,
        callOutcome,
        transcriptState,
        sessionId,
      });
      await schedulePostCallFollowup(transaction, {
        attemptId,
        required: applied.followupRequired,
      });
      await finishJob(transaction, job, workerId);
    });
  } catch (error) {
    const reason =
      error instanceof ArtifactVerifierError ||
      error instanceof PostCallProviderError
        ? error.code
        : error instanceof TypeError
          ? error.message
          : "post_call_failed";
    const permanent =
      error instanceof TypeError ||
      ((error instanceof ArtifactVerifierError ||
        error instanceof PostCallProviderError) &&
        !error.retryable);
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent)
        await transaction`
          UPDATE ops.jobs SET max_attempts = attempts
          WHERE id = ${job.id}::uuid AND status = 'running' AND locked_by = ${workerId}
        `;
      await transaction`
        SELECT ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${reason}, 15)
      `;
      // Visible to an operator rather than only in a log line: a pipeline that
      // gave up silently is indistinguishable from one still working.
      if (job.reference_id !== null)
        await transaction`
          UPDATE support.ticket_call_attempts
          SET post_call_error_safe = ${reason}, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = platform.current_tenant_id()
            AND id = ${job.reference_id}::uuid
        `;
    });
  }
}

/**
 * Send the wrap-up message, or record exactly why it was not sent.
 *
 * Separate from the summary job on purpose. Consent can be revoked and the
 * customer-service window can close between the call ending and this running,
 * and neither is a reason to undo a correctly analysed call — so this job owns
 * the send and its own retry budget, and a permanent block is a final,
 * operator-visible state rather than an endless retry.
 */
async function processPostCallFollowup(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
): Promise<void> {
  try {
    const attemptId = attemptReference(job);
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job);
      const plan = await loadFollowupPlan(transaction, attemptId);
      if (plan === undefined) throw new TypeError("followup_target_missing");
      if (plan === "blocked_consent") {
        await recordFollowupOutcome(transaction, {
          attemptId,
          state: "blocked_consent",
          errorSafe: "consent_withdrawn_before_sending",
        });
        await finishJob(transaction, job, workerId);
        return;
      }
      if (plan.provider === "simulator" && automation.simulatorEnabled !== true)
        throw new TypeError("simulation_disabled");
      if (await digitalServiceFormPending(transaction, plan.conversationId)) {
        await cancelJobForDisabledFeature(
          transaction,
          job,
          workerId,
          "digital_form_pending",
        );
        return;
      }
      if (plan.provider === "meta" && automation.realWhatsAppEnabled !== true)
        throw new TypeError("real_whatsapp_disabled");
      const actorUserId = await postCallActor(transaction);
      if (actorUserId === null)
        throw new TypeError("followup_actor_unavailable");
      const locale = latestMessageLocale(
        plan.configuredLocale,
        plan.latestInboundText,
      );
      // A telephone call does not open or extend the WhatsApp window. Outside
      // it, Meta permits only an approved template, and this deployment has no
      // approved post-call template — so the honest outcome is a recorded block
      // an operator can act on, not a message the provider would reject.
      if (plan.provider === "meta" && !plan.serviceWindowOpen) {
        await recordFollowupOutcome(transaction, {
          attemptId,
          state: "blocked_window",
          errorSafe: "outside_customer_service_window",
        });
        await recordTicketEvent(transaction, actorUserId, {
          ticketId: plan.ticketId,
          kind: "agent_message",
          actorKind: "system",
          summarySafe:
            "The wrap-up message was not sent: the WhatsApp customer-service window has closed.",
          evidence: { attemptId, reason: "outside_customer_service_window" },
        });
        await finishJob(transaction, job, workerId);
        return;
      }
      // Model-written next-action prose passes the same guard every other
      // delivered reply passes before a customer ever reads it.
      const nextAction =
        plan.nextAction !== null &&
        safeConversationalReply(plan.nextAction, { locale })
          ? plan.nextAction
          : null;
      const text = followupMessage({
        resolution: plan.resolution,
        ticketReference: plan.ticketReference,
        ticketSubject: plan.ticketSubject,
        nextAction,
        locale,
      });
      const outbound = await queueWhatsAppOutbound(
        transaction,
        {
          conversationId: plan.conversationId,
          explicitlyConfirmed: true,
          idempotencyKey: `support-followup:${attemptId}`,
          kind: "text",
          provider: plan.provider,
          realProviderEnabled: automation.realWhatsAppEnabled === true,
          recipientIdentityId: plan.recipientIdentityId,
          recipientAddress: plan.recipientAddress,
          senderUserId: actorUserId,
          senderType: "agent",
          text,
        },
        plan.channelConfiguration,
      );
      await recordFollowupOutcome(transaction, {
        attemptId,
        state: "sent",
        messageId: outbound.messageId,
      });
      await recordTicketEvent(transaction, actorUserId, {
        ticketId: plan.ticketId,
        kind: "agent_message",
        actorKind: "ai",
        visibility: "customer_visible",
        summarySafe: "Wrap-up message sent with the reply options.",
        evidence: { attemptId, messageId: outbound.messageId },
      });
      await finishJob(transaction, job, workerId);
    });
  } catch (error) {
    const reason =
      error instanceof TypeError ? error.message : "followup_failed";
    const permanent = error instanceof TypeError;
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent)
        await transaction`
          UPDATE ops.jobs SET max_attempts = attempts
          WHERE id = ${job.id}::uuid AND status = 'running' AND locked_by = ${workerId}
        `;
      await transaction`
        SELECT ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${reason}, 20)
      `;
      const dead = await transaction<{ dead: boolean }[]>`
        SELECT status = 'dead' AS dead FROM ops.jobs WHERE id = ${job.id}::uuid
      `;
      if (dead[0]?.dead === true && job.reference_id !== null)
        await recordFollowupOutcome(transaction, {
          attemptId: job.reference_id,
          state: "failed",
          errorSafe: reason,
        });
    });
  }
}

/**
 * Let a wrap-up reply answer the question it was asked.
 *
 * Deterministic on purpose. The message offered three numbered choices and
 * named the words for each, so almost every genuine answer is decidable without
 * a model — and when it is not, the ticket is left alone and the reply falls
 * through to the ordinary conversation. A customer opening a NEW problem in the
 * same thread must never be read as an answer about the old one.
 */
async function processPostCallReply(
  sql: Sql,
  workerId: string,
  job: JobRow,
): Promise<void> {
  try {
    const payload = record(job.payload);
    const conversationId = payload.conversationId;
    const messageId = payload.messageId;
    if (!uuid(conversationId) || !uuid(messageId) || job.reference_id === null)
      throw new TypeError("post_call_reply_reference_invalid");
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job);
      const ticket = await awaitingCustomerTicket(transaction, conversationId);
      if (await digitalServiceFormPending(transaction, conversationId)) {
        await cancelJobForDisabledFeature(
          transaction,
          job,
          workerId,
          "digital_form_pending",
        );
        return;
      }
      if (ticket === undefined) {
        await finishJob(transaction, job, workerId);
        return;
      }
      const message = await transaction<{ content_text: string | null }[]>`
        SELECT content_text FROM messaging.messages
        WHERE tenant_id = platform.current_tenant_id() AND id = ${messageId}::uuid
          AND conversation_id = ${conversationId}::uuid AND direction = 'inbound'
      `;
      const intent = classifyCustomerReply(message[0]?.content_text ?? "");
      if (intent === "unclear") {
        await finishJob(transaction, job, workerId);
        return;
      }
      const actorUserId = await postCallActor(transaction);
      await applyCustomerConfirmation(transaction, actorUserId, {
        ticketId: ticket.ticketId,
        intent,
        messageId,
      });
      await finishJob(transaction, job, workerId);
    });
  } catch (error) {
    const reason =
      error instanceof TypeError ? error.message : "post_call_reply_failed";
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (error instanceof TypeError)
        await transaction`
          UPDATE ops.jobs SET max_attempts = attempts
          WHERE id = ${job.id}::uuid AND status = 'running' AND locked_by = ${workerId}
        `;
      await transaction`
        SELECT ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${reason}, 10)
      `;
    });
  }
}

/**
 * Send a phone inquiry's WhatsApp summary and photo request.
 *
 * Every outcome lands on the inquiry: admitted for delivery, or an explicit
 * blocked/failed state staff can act on. A missing prerequisite is a durable
 * business outcome, not a retry loop. Only transient infrastructure errors
 * retry, bounded by the job's attempt limit, under one idempotency key.
 */
async function processIntakeFollowup(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
): Promise<void> {
  const intakeId = job.reference_id ?? "";
  const settle = async (
    transaction: postgres.TransactionSql,
    status: string,
    error: string | null,
  ) => {
    await transaction`SELECT service.record_intake_followup(${intakeId}::uuid,${status},NULL,${error})`;
    await finishJob(transaction, job, workerId);
  };
  try {
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job);
      try {
        await requireTenantFeatures(transaction, ["field_service", "whatsapp"]);
      } catch (error) {
        if (!(error instanceof TenantFeatureRuntimeError)) throw error;
        await settle(transaction, "no_channel", "feature_disabled");
        return;
      }
      const plans = await transaction<{ plan: IntakeFollowupPlan }[]>`
        SELECT service.intake_followup_plan(${intakeId}::uuid) AS plan
      `;
      const plan = plans[0]?.plan;
      if (plan === undefined)
        throw new TypeError("intake follow-up plan missing");
      if (plan.followupStatus === "admitted") {
        await finishJob(transaction, job, workerId);
        return;
      }
      if (plan.optedOut === true || plan.consent !== "granted") {
        await settle(transaction, "blocked_consent", null);
        return;
      }
      const prepared = await transaction<
        {
          recipient: {
            status: string;
            conversationId?: string;
            provider?: "meta" | "simulator";
            channelConfiguration?: Record<string, unknown>;
            recipientIdentityId?: string;
            recipientAddress?: string;
            windowOpen?: boolean;
          };
        }[]
      >`SELECT service.prepare_intake_followup_recipient(${intakeId}::uuid) AS recipient`;
      const recipient = prepared[0]?.recipient;
      if (
        recipient?.status !== "ready" ||
        recipient.conversationId === undefined ||
        recipient.provider === undefined ||
        recipient.recipientIdentityId === undefined ||
        recipient.recipientAddress === undefined
      ) {
        const status = recipient?.status;
        await settle(
          transaction,
          status === "recipient_conflict" || status === "no_recipient"
            ? status
            : "no_channel",
          null,
        );
        return;
      }
      if (
        recipient.provider === "meta" &&
        automation.realWhatsAppEnabled !== true
      ) {
        await settle(transaction, "no_channel", "real_whatsapp_disabled");
        return;
      }
      const actor = await postCallActor(transaction);
      if (actor === null) {
        await settle(transaction, "no_channel", "no_authorized_sender");
        return;
      }
      await transaction`SELECT set_config('app.current_user', ${actor}, true)`;
      const delivery = followupDelivery(
        plan,
        recipient.provider,
        recipient.windowOpen === true,
      );
      if (delivery.kind === "blocked") {
        await settle(transaction, delivery.reason, null);
        return;
      }
      const identities = await transaction<
        { profile: TenantIdentityProjection | null }[]
      >`SELECT platform.current_voice_tenant_support_profile() AS profile`;
      const businessName = tenantDisplayNameFrom(
        identities[0]?.profile ?? null,
      );
      const configuration = recipient.channelConfiguration ?? {};
      const channelConfig =
        typeof configuration.graphApiVersion === "string" &&
        typeof configuration.phoneNumberId === "string" &&
        typeof configuration.wabaId === "string"
          ? {
              graphApiVersion: configuration.graphApiVersion,
              phoneNumberId: configuration.phoneNumberId,
              wabaId: configuration.wabaId,
            }
          : undefined;
      const common = {
        conversationId: recipient.conversationId,
        explicitlyConfirmed: true,
        idempotencyKey: `service-followup:${intakeId}`,
        provider: recipient.provider,
        realProviderEnabled: automation.realWhatsAppEnabled === true,
        recipientIdentityId: recipient.recipientIdentityId,
        recipientAddress: recipient.recipientAddress,
        senderUserId: actor,
        senderType: "system" as const,
        voiceFollowUpIntakeId: intakeId,
      };
      const formUrl =
        plan.followUp?.mode === "form"
          ? await issueDigitalServiceForm(
              transaction,
              intakeId,
              automation.publicSiteUrl ?? "",
            )
          : undefined;
      const outbound = await queueWhatsAppOutbound(
        transaction,
        delivery.kind === "text"
          ? {
              ...common,
              kind: "text",
              text: renderIntakeFollowup(plan, businessName, formUrl),
            }
          : {
              ...common,
              kind: "template",
              templateName: delivery.templateName,
              language: delivery.language,
              parameters: followupTemplateParameters(plan, businessName),
            },
        channelConfig,
      );
      await transaction`
        SELECT service.record_intake_followup(${intakeId}::uuid,'admitted',${outbound.messageId}::uuid,NULL)
      `;
      await finishJob(transaction, job, workerId);
    });
  } catch (error) {
    // A refusal from the outbound boundary (consent, window, recipient) is a
    // business outcome; anything else is transient and retried.
    const refused = error instanceof TypeError;
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (refused) {
        await transaction`
          SELECT service.record_intake_followup(${intakeId}::uuid,'failed',NULL,
            ${error.message.slice(0, 200)})
        `;
        await transaction`UPDATE ops.jobs SET max_attempts=attempts WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}`;
      }
      await transaction`SELECT ops.fail_messaging_job_claim(${job.id}::uuid,${workerId},${job.claim_token}::uuid,${refused ? "intake_followup_refused" : "intake_followup_failed"},30)`;
      // Retries exhausted: the inquiry must say so rather than stay queued.
      if (!refused)
        await transaction`
          SELECT service.record_intake_followup(${intakeId}::uuid,'failed',NULL,'delivery_admission_failed')
          FROM ops.jobs WHERE id=${job.id}::uuid AND status='dead'
        `;
    });
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
  let openingMenuRoute: OpeningMenuRoute | undefined;
  if (
    [
      "whatsapp.ai.reply",
      "whatsapp.ai.call",
      "whatsapp.audio.transcribe",
      "whatsapp.unsupported.reply",
      "field_service.intake.extract",
      "support.postcall.reply",
    ].includes(job.job_type)
  ) {
    const conversationId =
      record(job.payload).conversationId ??
      (job.job_type.startsWith("whatsapp.") ? job.reference_id : undefined);
    if (uuid(conversationId)) {
      const blocked = await withOwnedJobTransaction(
        sql,
        workerId,
        job,
        async (tx) => {
          await setTenantContext(tx, job.tenant_id);
          await requireOwnedJob(tx, workerId, job);
          if (!(await digitalServiceFormPending(tx, conversationId)))
            return false;
          await cancelJobForDisabledFeature(
            tx,
            job,
            workerId,
            "digital_form_pending",
          );
          return true;
        },
      );
      if (blocked) return;
    }
  }
  if (
    [
      "field_service.ocr",
      "field_service.photo_request",
      "field_service.intake_followup",
      "field_service.summary",
      "whatsapp.outbound.send",
      "whatsapp.ai.call",
    ].includes(job.job_type) &&
    !(await openingMenuBusinessJobAllowed(sql, workerId, job))
  ) {
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await requireOwnedJob(transaction, workerId, job);
      if (job.job_type === "field_service.ocr" && job.reference_id !== null)
        await transaction`UPDATE service.ocr_results SET status='failed',
          error_safe='opening_menu_route_denied',completed_at=clock_timestamp()
          WHERE id=${job.reference_id}::uuid AND status IN ('pending','processing')`;
      if (job.job_type === "field_service.summary" && job.reference_id !== null)
        await transaction`UPDATE service.case_summaries SET status='failed',
          error_safe='opening_menu_route_denied',completed_at=clock_timestamp()
          WHERE id=${job.reference_id}::uuid AND status IN ('pending','processing')`;
      if (
        job.job_type === "whatsapp.outbound.send" &&
        job.reference_id !== null
      ) {
        await transaction`UPDATE messaging.outbound_requests SET status='failed',
          last_error_code='opening_menu_route_denied',completed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE id=${job.reference_id}::uuid AND status IN ('queued','sending')`;
        await transaction`UPDATE messaging.messages SET status='failed',updated_at=clock_timestamp()
          WHERE id=(SELECT message_id FROM messaging.outbound_requests WHERE id=${job.reference_id}::uuid)
            AND status='queued'`;
      }
      await cancelJobForDisabledFeature(
        transaction,
        job,
        workerId,
        "opening_menu_route_denied",
      );
    });
    return;
  }
  if (
    (job.job_type === "whatsapp.ai.reply" ||
      job.job_type === "whatsapp.opening_menu" ||
      job.job_type === "field_service.intake.extract") &&
    job.reference_id !== null
  ) {
    try {
      const menuStore = createOpeningMenuStore(sql, workerId, job);
      const result = await processOpeningMenuJob(
        menuStore,
        createOpeningMenuProvider(
          menuStore,
          providers.meta,
          automation.resolveChannelCredential,
        ),
      );
      openingMenuRoute = menuRoute(result.decision);
      if (
        result.handled ||
        job.job_type === "whatsapp.opening_menu" ||
        (job.job_type === "field_service.intake.extract" &&
          openingMenuRoute !== undefined &&
          !openingMenuRoute.allowedCapabilities.includes("service.intake"))
      ) {
        await withOwnedJobTransaction(
          sql,
          workerId,
          job,
          async (transaction) => {
            await requireOwnedJob(transaction, workerId, job);
            if (result.decision.kind !== "offer") {
              const reason =
                result.decision.kind === "route"
                  ? "opening_menu_route_denied"
                  : `opening_menu_${result.decision.kind}_${result.decision.reason ?? "no_action"}`
                      .replaceAll("-", "_")
                      .slice(0, 180);
              await cancelJobForDisabledFeature(
                transaction,
                job,
                workerId,
                reason,
              );
              return;
            }
            await transaction`
            UPDATE ops.jobs SET status='succeeded', completed_at=CURRENT_TIMESTAMP,
              locked_at=NULL, locked_by=NULL, last_error_safe=NULL, updated_at=CURRENT_TIMESTAMP
            WHERE id=${job.id}::uuid AND locked_by=${workerId}
          `;
          },
        );
        return;
      }
    } catch (error) {
      const providerError =
        error instanceof WhatsAppProviderError
          ? error
          : error instanceof Error &&
              error.cause instanceof WhatsAppProviderError
            ? error.cause
            : undefined;
      const delay = providerError?.retryAfterMs;
      const invalidDelay =
        delay !== undefined &&
        (!Number.isFinite(delay) || delay < 0 || delay > 86_400_000);
      await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
        if (invalidDelay)
          await transaction`UPDATE ops.jobs SET max_attempts=attempts WHERE id=${job.id}::uuid`;
        await transaction`SELECT ops.fail_messaging_job_claim(
          ${job.id}::uuid,${workerId},${job.claim_token}::uuid,
          ${invalidDelay ? "Opening menu rate limit quarantined" : "Opening menu work failed"},30)`;
        if (!invalidDelay && delay !== undefined)
          await transaction`UPDATE ops.jobs SET available_at=GREATEST(available_at,
            clock_timestamp()+${delay}::double precision * interval '1 millisecond')
            WHERE id=${job.id}::uuid AND tenant_id=platform.current_tenant_id() AND status='retry'`;
      });
      return;
    }
  }
  if (job.job_type === "memory.summary") {
    await processMemorySummaryJob(
      {
        load: () =>
          withOwnedJobTransaction(sql, workerId, job, async (tx) => {
            await setTenantContext(tx, job.tenant_id);
            const rows = await tx<{ work: MemorySummaryWork }[]>`
          SELECT platform.load_memory_summary_job(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS work`;
            if (!rows[0]?.work) throw new TypeError("summary work unavailable");
            return rows[0].work;
          }),
        persist: async (text) => {
          await withOwnedJobTransaction(sql, workerId, job, async (tx) => {
            await setTenantContext(tx, job.tenant_id);
            await tx`SELECT platform.persist_memory_summary_job(${job.id}::uuid,${workerId},${job.claim_token}::uuid,${text})`;
          });
        },
        fail: async (reason) => {
          await withOwnedJobTransaction(sql, workerId, job, async (tx) => {
            await setTenantContext(tx, job.tenant_id);
            await tx`SELECT ops.fail_messaging_job_claim(${job.id}::uuid,${workerId},${job.claim_token}::uuid,${reason},30)`;
          });
        },
      },
      automation.memorySummaryProvider ??
        (automation.modelRouting?.resolveSealedCredential === undefined
          ? undefined
          : createMemorySummaryModelProvider({
              resolve: automation.modelRouting.resolveSealedCredential,
              ...(automation.memorySummaryFetch === undefined
                ? {}
                : { fetch: automation.memorySummaryFetch }),
              project: () =>
                withOwnedJobTransaction(sql, workerId, job, async (tx) => {
                  await setTenantContext(tx, job.tenant_id);
                  const rows = await tx<
                    { projection: SummaryModelProjection }[]
                  >`SELECT platform.memory_summary_model_projection(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS projection`;
                  if (!rows[0]?.projection)
                    throw new TypeError("summary route unavailable");
                  return rows[0].projection;
                }),
              reserve: (expected) =>
                withOwnedJobTransaction(sql, workerId, job, async (tx) => {
                  await setTenantContext(tx, job.tenant_id);
                  const rows = await tx<
                    { attempt: string }[]
                  >`SELECT platform.reserve_memory_summary_attempt(${job.id}::uuid,${workerId},${job.claim_token}::uuid,${JSON.stringify(expected)}::text::jsonb) AS attempt`;
                  if (!rows[0]?.attempt)
                    throw new TypeError("summary reservation unavailable");
                  return rows[0].attempt;
                }),
              settle: async (attempt, success, input, output) => {
                await withOwnedJobTransaction(
                  sql,
                  workerId,
                  job,
                  async (tx) => {
                    await setTenantContext(tx, job.tenant_id);
                    await tx`SELECT platform.settle_memory_summary_attempt(${job.id}::uuid,${workerId},${job.claim_token}::uuid,${attempt}::uuid,${success},${input}::integer,${output}::integer)`;
                  },
                );
              },
            })),
    );
    return;
  }
  if (job.job_type === "whatsapp.operator.alert") {
    await processOperatorAlert(
      sql,
      workerId,
      job,
      automation.operatorAlertProvider,
    );
    return;
  }
  if (
    job.job_type === "field_service.photo_request" &&
    job.reference_id !== null
  ) {
    try {
      await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
        await setTenantContext(transaction, job.tenant_id);
        await requireOwnedJob(transaction, workerId, job);
        await requireTenantFeatures(transaction, ["field_service", "whatsapp"]);
        const requestedText = record(job.payload).text;
        if (
          typeof requestedText !== "string" ||
          requestedText.trim().length === 0 ||
          requestedText.length > 2000
        )
          throw new TypeError("Invalid photo request text");
        const candidates = await transaction<
          {
            conversation_id: string;
            actor_id: string;
            provider: "meta" | "simulator";
            configuration: Record<string, unknown>;
            text: string;
          }[]
        >`
        SELECT c.id AS conversation_id,c.ai_enabled_by_user_id AS actor_id,ch.provider,ch.configuration,${requestedText} AS text
        FROM service.intake_drafts d JOIN messaging.conversations c ON c.tenant_id=d.tenant_id AND c.id=d.conversation_id
        JOIN messaging.channels ch ON ch.tenant_id=c.tenant_id AND ch.id=c.channel_id
        WHERE d.id=${job.reference_id}::uuid AND c.ownership_mode='ai' AND c.removed_from_inbox_at IS NULL
          AND ch.status='active' AND ch.provider IN ('meta','simulator')
          AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)`;
        const candidate = candidates[0];
        if (
          candidate !== undefined &&
          (await digitalServiceFormPending(
            transaction,
            candidate.conversation_id,
          ))
        ) {
          await cancelJobForDisabledFeature(
            transaction,
            job,
            workerId,
            "digital_form_pending",
          );
          return;
        }
        if (
          candidate === undefined ||
          (candidate.provider === "meta" &&
            automation.realWhatsAppEnabled !== true)
        ) {
          await transaction`UPDATE ops.jobs SET status='cancelled',last_error_safe='photo_request_channel_unavailable',locked_by=NULL,locked_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=${job.id}::uuid`;
          return;
        }
        await transaction`SELECT set_config('app.current_user',${candidate.actor_id},true)`;
        // Older agents supplied this text themselves. Whatever its origin it
        // must pass the platform scope boundary before a customer sees it.
        const photoText = validateAgentOutput(candidate.text).allowed
          ? candidate.text
          : /[\u0590-\u05ff]/u.test(candidate.text)
            ? "שלום, כדי להמשיך בטיפול בפנייה שלך נשמח לקבל תמונה של התקלה בתשובה להודעה זו."
            : "Hello, to continue with your service request please reply with a photo of the fault.";
        const config = candidate.configuration;
        const channelConfig =
          typeof config.graphApiVersion === "string" &&
          typeof config.phoneNumberId === "string" &&
          typeof config.wabaId === "string"
            ? {
                graphApiVersion: config.graphApiVersion,
                phoneNumberId: config.phoneNumberId,
                wabaId: config.wabaId,
              }
            : undefined;
        await queueWhatsAppOutbound(
          transaction,
          {
            conversationId: candidate.conversation_id,
            explicitlyConfirmed: true,
            idempotencyKey: `service-photo:${job.id}`,
            kind: "text",
            provider: candidate.provider,
            realProviderEnabled: automation.realWhatsAppEnabled === true,
            senderUserId: candidate.actor_id,
            senderType: "agent",
            text: photoText,
          },
          channelConfig,
        );
        await finishJob(transaction, job, workerId);
      });
    } catch (error) {
      await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
        await setTenantContext(transaction, job.tenant_id);
        if (error instanceof TypeError)
          await transaction`UPDATE ops.jobs SET max_attempts=attempts WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}`;
        await transaction`SELECT ops.fail_messaging_job_claim(${job.id}::uuid,${workerId},${job.claim_token}::uuid,'photo_request_admission_failed',10)`;
      });
    }
    return;
  }
  if (
    job.job_type === "field_service.intake_followup" &&
    job.reference_id !== null
  ) {
    await processIntakeFollowup(sql, workerId, job, automation);
    return;
  }
  if (job.job_type === "support.postcall.process") {
    await processPostCall(sql, workerId, job, automation);
    return;
  }
  if (job.job_type === "support.postcall.followup") {
    await processPostCallFollowup(sql, workerId, job, automation);
    return;
  }
  if (job.job_type === "support.postcall.reply") {
    await processPostCallReply(sql, workerId, job);
    return;
  }
  if (
    (job.job_type === "whatsapp.media.retrieve" ||
      job.job_type === "field_service.whatsapp_media.retrieve") &&
    job.reference_id !== null
  ) {
    await processWhatsAppMedia(sql, workerId, job, providers, automation);
    return;
  }
  if (
    job.job_type === "field_service.intake.extract" &&
    job.reference_id !== null
  ) {
    await processFieldServiceIntake(
      sql,
      workerId,
      job,
      automation,
      openingMenuRoute,
    );
    return;
  }
  if (job.job_type === "field_service.ocr" && job.reference_id !== null) {
    await processFieldServiceOcr(sql, workerId, job, automation);
    return;
  }
  if (job.job_type === "field_service.summary" && job.reference_id !== null) {
    await processFieldServiceSummary(sql, workerId, job, automation);
    return;
  }
  if (job.job_type === "whatsapp.outbound.send" && job.reference_id !== null) {
    await processWhatsAppOutbound(
      sql,
      workerId,
      job,
      providers,
      reportFailure,
      automation.simulatorEnabled === true,
      automation.resolveChannelCredential,
    );
    return;
  }
  if (
    job.job_type === "whatsapp.audio.transcribe" &&
    job.reference_id !== null
  ) {
    try {
      await processAudioTranscription(sql, workerId, job, automation);
    } catch (error) {
      await withOwnedJobTransaction(sql, workerId, job, async (tx) => {
        await setTenantContext(tx, job.tenant_id);
        if (error instanceof TypeError)
          await tx`UPDATE ops.jobs SET max_attempts=attempts WHERE id=${job.id}::uuid`;
        await tx`SELECT ops.fail_messaging_job_claim(${job.id}::uuid,${workerId},${job.claim_token}::uuid,
          ${error instanceof TypeError ? error.message : "audio transcription work failed"},10)`;
      });
    }
    return;
  }
  if (job.job_type === "whatsapp.ai.reply" && job.reference_id !== null) {
    await processWhatsAppAiReply(
      sql,
      workerId,
      job,
      automation,
      openingMenuRoute,
    );
    return;
  }
  if (
    job.job_type === "whatsapp.unsupported.reply" &&
    job.reference_id !== null
  ) {
    await processUnsupportedMediaReply(sql, workerId, job, automation);
    return;
  }
  if (job.job_type === "whatsapp.ai.call" && job.reference_id !== null) {
    await processAutomaticCall(sql, workerId, job, automation);
    return;
  }
  try {
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
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
        await requireTenantFeatures(transaction, ["whatsapp"]);
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
        await requireTenantFeatures(transaction, ["whatsapp"]);
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
      error instanceof TenantFeatureRuntimeError
        ? error.code
        : error instanceof TypeError
          ? error.message
          : "messaging job failed";
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (error instanceof TypeError) {
        await transaction`
          UPDATE ops.jobs SET max_attempts = attempts
          WHERE id = ${job.id}::uuid AND status = 'running' AND locked_by = ${workerId}
        `;
      }
      await transaction`
        SELECT ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${reason}, 5)
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

/**
 * What `platform.current_voice_tenant_support_profile()` returns. The name is
 * historical — the projection is the one tenant-identity source both
 * conversational runtimes read, and neither of them may select the underlying
 * `crm.tenant_settings` columns directly.
 */
interface TenantIdentityProjection {
  readonly tenantName?: string | null;
  readonly displayName?: string | null;
  readonly businessName?: string | null;
  readonly supportProfile?: {
    readonly supportDisplayName?: string | null;
    readonly businessDescription?: unknown;
    readonly productsAndServices?: unknown;
  } | null;
}

/**
 * The same precedence the voice runtime applies in
 * `support_context.support_profile_from_database`: a name the tenant
 * configured wins, then the legacy columns, and a blank string counts as
 * unset rather than as an empty brand.
 */
function tenantDisplayNameFrom(
  profile: TenantIdentityProjection | null,
): string | null {
  const candidates = [
    profile?.supportProfile?.supportDisplayName,
    profile?.businessName,
    profile?.displayName,
    profile?.tenantName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "")
      return candidate;
  }
  return null;
}

interface AiWork {
  readonly agentVersionId: string;
  readonly modelConfigurationId: string | null;
  readonly channelId: string;
  /** The resolved configuration this job runs under, pinned at admission. */
  readonly contract: AgentExecutionContract;
  readonly tenantDisplayName: string | null;
  readonly businessProfile?: TenantBusinessContext;
  /**
   * The lead this conversation is already collecting into, if any. Null until
   * the agent saves something: a greeting does not create a lead.
   */
  readonly lead: {
    readonly id: string;
    readonly revision: number;
    readonly status: string;
    readonly collected: readonly {
      readonly key: string;
      readonly state: string;
      readonly value: string | null;
    }[];
    readonly missingRequired: readonly string[];
  } | null;
  readonly knowledge: readonly EligibleKnowledgeFact[];
  readonly contextBudgetEnabled: boolean;
  readonly knowledgeChunks?: readonly {
    readonly documentId: string;
    readonly content: string;
  }[];
  readonly sessionMemory?: string;
  /**
   * Whether this version's escalations open or update a support ticket: it
   * holds `ticket.open`, or it was published before capabilities existed and
   * keeps the behaviour it was published with. A lead or survey agent still
   * escalates to a person; it just does not turn that into a support issue.
   */
  readonly opensTickets: boolean;
  readonly machineToolPrincipalId?: string;
  readonly ownershipEpoch: string;
  readonly authorizedUserId: string;
  readonly contactId: string;
  readonly conversationId: string;
  readonly locale: string;
  readonly provider: "simulator" | "meta";
  readonly recipientAddress?: string;
  readonly recipientIdentityId?: string;
  readonly systemPrompt: string;
  readonly serviceIntake?: NonNullable<
    Parameters<WhatsAppAiProvider["decide"]>[0]["serviceIntake"]
  >;
  readonly contactContext: NonNullable<
    Parameters<WhatsAppAiProvider["decide"]>[0]["contactContext"]
  >;
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
  // Provider seconds and later media updates cannot order customer turns.
  // New Meta events use immutable database receipt sequence; legacy/simulator
  // messages retain the older fallback because their receipt order is unknown.
  const latest = await transaction<{ id: string }[]>`
    SELECT message.id FROM messaging.messages message
    JOIN messaging.conversations conversation ON conversation.id=message.conversation_id AND conversation.tenant_id=message.tenant_id
    JOIN messaging.channels channel ON channel.id=conversation.channel_id AND channel.tenant_id=conversation.tenant_id
    LEFT JOIN ops.inbound_events event ON event.tenant_id=message.tenant_id AND event.provider=message.provider
      AND event.provider_account_id=channel.provider_account_id AND event.payload->>'providerMessageId'=message.provider_message_id
    WHERE message.conversation_id=${conversationId}::uuid AND message.direction='inbound' AND message.content_type<>'event'
      ORDER BY COALESCE(event.received_at,message.created_at) DESC,event.receipt_sequence DESC NULLS LAST,
        message.created_at DESC,message.updated_at DESC,message.id DESC LIMIT 1
  `;
  if (latest[0]?.id !== triggerMessageId)
    throw new TypeError("AI inbound trigger superseded");
  // A verified webhook may arrive while the single worker awaits the model.
  // It is already a newer customer turn even before inbox materialization.
  // Match account and immutable sender origin, never mutable model metadata.
  await requireNoNewerPendingInbound(
    transaction,
    conversationId,
    triggerMessageId,
  );
}

async function recentDeliveredReplies(
  transaction: postgres.TransactionSql,
  conversationId: string,
  excludeMessageId?: string,
): Promise<readonly string[]> {
  const rows = await transaction<{ content_text: string }[]>`
    SELECT content_text FROM messaging.messages
    WHERE conversation_id=${conversationId}::uuid
      AND direction='outbound'
      AND content_type='text' AND content_text IS NOT NULL
      AND status IN ('sent','delivered','read')
      AND (${excludeMessageId ?? null}::uuid IS NULL OR id<>${excludeMessageId ?? null}::uuid)
    ORDER BY created_at DESC, updated_at DESC, id DESC
    LIMIT ${recentReplyWindowSize}
  `;
  return rows.map((row) => row.content_text);
}

async function loadAiWork(
  sql: Sql,
  workerId: string,
  job: JobRow,
  openingMenuRoute?: OpeningMenuRoute,
): Promise<AiWork> {
  return withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job);
    const triggerMessageId = triggerFromJob(job);
    // Capacity admission and session revision admission are distinct. Select
    // before the Agent join so contracts, knowledge and model routing use one
    // atomic server-derived version; preprocessing jobs retain their own path.
    if (job.job_type === "whatsapp.ai.reply") {
      await transaction`
        SELECT platform.admit_messaging_session_agent(
          ${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, 12
        )
      `;
    }
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
        agent_profile_id: string;
        model_configuration_id: string | null;
        channel_id: string;
        agent_version: number;
        agent_channels: string[];
        agent_tool_permissions: unknown;
        agent_channel_configuration: Record<string, unknown> | null;
        agent_published_at: Date;
        agent_validation_status: string;
        agent_implicit_ticketing: boolean;
        contact_id: string;
        contact_name: string;
        contact_email: string | null;
        contact_company: string | null;
        lifecycle_status: string;
        contact_created_at: Date;
        conversation_created_at: Date;
      }[]
    >`
      SELECT conversation.id AS conversation_id,
             conversation.ai_enabled_by_user_id,
             agent.system_prompt, agent.locale, agent.id AS agent_version_id,
             agent.model_configuration_id, channel.id AS channel_id,
             agent.agent_profile_id, agent.version AS agent_version,
             agent.channel_capabilities AS agent_channels,
             agent.tool_permissions AS agent_tool_permissions,
             agent.channel_configuration AS agent_channel_configuration,
             agent.implicit_ticketing AS agent_implicit_ticketing,
             agent.published_at AS agent_published_at,
             agent.validation_status AS agent_validation_status,
             conversation.ownership_epoch,
             channel.provider, channel.configuration, contact.id AS contact_id,
             contact.name AS contact_name, contact.email AS contact_email,
             contact.company AS contact_company, contact.lifecycle_status,
             contact.created_at AS contact_created_at,
             conversation.created_at AS conversation_created_at
      FROM messaging.conversations conversation
      JOIN crm.contacts contact ON contact.id=conversation.contact_id
        AND contact.tenant_id=conversation.tenant_id
      JOIN agents.agent_profile_versions agent
        ON agent.id = conversation.ai_agent_profile_version_id
       AND agent.tenant_id = conversation.tenant_id
      JOIN agents.agent_profiles profile
        ON profile.id = agent.agent_profile_id
       AND profile.tenant_id = agent.tenant_id
       AND profile.archived_at IS NULL
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
    // One explicit execution configuration for this conversation, resolved
    // server-side before the model is consulted. The conversation pins the
    // version; an unpublished revision published mid-conversation does not
    // reach an already admitted job, and a mismatched binding fails loudly
    // rather than falling back to the tenant default.
    const versionRow = {
      agentProfileId: row.agent_profile_id,
      agentProfileVersionId: row.agent_version_id,
      version: row.agent_version,
      systemPrompt: row.system_prompt,
      locale: row.locale,
      channelCapabilities: row.agent_channels,
      toolPermissions: row.agent_tool_permissions,
      channelConfiguration: row.agent_channel_configuration,
      publishedAt: row.agent_published_at,
      validationStatus: row.agent_validation_status,
    };
    const pinnedSchemaId = pinnedLeadFieldSchemaId(versionRow);
    const originalContract = buildAgentExecutionContract({
      tenantId: job.tenant_id,
      contactId: row.contact_id,
      channel: "whatsapp",
      interaction: {
        kind: "whatsapp_conversation",
        id: row.conversation_id,
        ownershipEpoch: row.ownership_epoch,
      },
      authorizedUserId: row.ai_enabled_by_user_id,
      assignmentSource: "explicit_assignment",
      version: versionRow,
      expectedAgentVersionId: row.agent_version_id,
      leadFieldSchema:
        pinnedSchemaId === null
          ? null
          : await loadLeadFieldSchema(transaction, pinnedSchemaId),
    });
    if (
      openingMenuRoute !== undefined &&
      openingMenuRoute.agentVersionId !== row.agent_version_id
    )
      throw new TypeError("Opening menu Agent admission changed");
    const contract: AgentExecutionContract =
      openingMenuRoute === undefined
        ? originalContract
        : {
            ...originalContract,
            capabilities: originalContract.capabilities.filter((capability) =>
              openingMenuRoute.allowedCapabilities.includes(capability),
            ),
            locale: openingMenuRoute.language,
            agentPrompt: `${originalContract.agentPrompt}\nCustomer selected business route: ${openingMenuRoute.intent}. Respond in ${openingMenuRoute.language}. Use only the supplied allowed tools.`,
            leadFieldSchema: openingMenuRoute.allowedCapabilities.some(
              (capability) => capability.startsWith("lead."),
            )
              ? originalContract.leadFieldSchema
              : null,
          };
    if (openingMenuRoute !== undefined && contract.capabilities.length === 0)
      throw new TypeError(
        "Opening menu route has no approved Agent capabilities",
      );
    await requireTenantFeatures(transaction, [
      "whatsapp",
      ...contract.capabilities.map(capabilityRequiredFeature),
    ]);
    const informationalOnly = job.job_type === "whatsapp.unsupported.reply";
    // Transcription retains the Agent's configured capabilities so subsequent
    // extraction can be queued, but it does not execute a business tool. That
    // later job must independently obtain its own canonical tool admission.
    const transcriptionOnly = job.job_type === "whatsapp.audio.transcribe";
    const firstToolCapability =
      informationalOnly || transcriptionOnly
        ? undefined
        : contract.capabilities[0];
    const machine =
      firstToolCapability === undefined
        ? null
        : await authorizeMachineTool(
            transaction,
            job,
            workerId,
            firstToolCapability,
            {
              agentVersionId: row.agent_version_id,
              conversationId: row.conversation_id,
              contactId: row.contact_id,
              triggerMessageId,
              ownershipEpoch: row.ownership_epoch,
            },
          );
    const lead =
      informationalOnly ||
      transcriptionOnly ||
      contract.leadFieldSchema === null ||
      !hasCapability(contract.capabilities, "lead.read")
        ? null
        : await findInteractionLead(transaction, {
            contactId: contract.contactId,
            sourceChannel: "whatsapp",
            capabilities: contract.capabilities,
            ...(machine === null
              ? { actorUserId: row.ai_enabled_by_user_id }
              : {
                  executionClaim: {
                    jobId: job.id,
                    workerId,
                    claimToken: job.claim_token,
                  },
                }),
            recordedBy: "agent",
            agentProfileVersionId: row.agent_version_id,
            conversationId: contract.interaction.id,
          });
    // The tenant the agent speaks for. Its identity is not the agent's to
    // choose, so it is read here rather than taken from the prompt — and read
    // through the same tenant-bound projection the voice runtime uses, because
    // this role is deliberately not allowed to select tenant_settings columns.
    const identities = await transaction<
      { profile: TenantIdentityProjection | null }[]
    >`
      SELECT platform.current_voice_tenant_support_profile() AS profile
    `;
    const tenantDisplayName = tenantDisplayNameFrom(
      identities[0]?.profile ?? null,
    );
    const businessProfile = tenantBusinessContext(
      identities[0]?.profile?.supportProfile,
    );
    const knowledge = await eligibleFacts(transaction, row.agent_version_id);
    const rawHistory = await transaction<
      {
        id: string;
        direction: "inbound" | "outbound";
        content_text: string | null;
        content_type: string;
        created_at: Date;
        sender_address: string | null;
        sender_identity_id: string | null;
      }[]
    >`
      SELECT message.id, message.direction, message.content_text, message.content_type,
             message.created_at, origin.contact_identity_id AS sender_identity_id,
             origin.sender_address
      FROM messaging.messages message
      LEFT JOIN messaging.inbound_message_origins origin
        ON origin.tenant_id=message.tenant_id AND origin.message_id=message.id
      WHERE message.conversation_id = ${row.conversation_id}::uuid
        AND ((message.content_type IN ('text','template') AND message.content_text IS NOT NULL)
          OR (message.direction='inbound' AND message.content_type IN ('image','document','location','audio','video','interactive')))
        AND ((message.direction='inbound' AND message.status='received') OR
             (message.direction='outbound' AND
              message.status IN ('sent','delivered','read')))
        -- A conversation reopened after Inbox removal is a new thread. The
        -- removed thread's messages (a request for a person, a takeover) made
        -- the model hand every new question straight back to a human.
        AND (message.id = ${triggerMessageId}::uuid
          OR message.created_at >= COALESCE((
            SELECT conversation.inbox_reopened_at
            FROM messaging.conversations conversation
            WHERE conversation.id = ${row.conversation_id}::uuid
          ), '-infinity'::timestamptz))
      ORDER BY message.created_at DESC, message.updated_at DESC, message.id DESC LIMIT 50
    `;
    const history = rawHistory.map((message) => ({
      ...message,
      original_content_text: message.content_text,
      content_text: messageContextText(
        message.content_type,
        message.content_text,
      ),
    }));
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
    const triggerMessage = history.find(
      (message) => message.id === triggerMessageId,
    );
    if (triggerMessage === undefined)
      throw new TypeError("AI conversation has no inbound trigger message");
    const retrievalEnabled = await remediationEnabled(
      transaction,
      "retrieval_fts",
    );
    const knowledgeChunks = retrievalEnabled
      ? await retrieveAgentKnowledge(transaction, {
          tenantId: job.tenant_id,
          agentVersionId: row.agent_version_id,
          question: (triggerMessage.original_content_text ?? "").slice(0, 4096),
        })
      : [];
    const memory = await loadSessionMemoryContext(
      transaction,
      {
        tenantId: job.tenant_id,
        conversationId: row.conversation_id,
        agentVersionId: row.agent_version_id,
        contactId: row.contact_id,
        latestTriggerMessageId: triggerMessageId,
      },
      { preserveAdmission: job.job_type === "whatsapp.ai.reply" },
    );
    const recipientIdentityId =
      typeof triggerMessage.sender_identity_id === "string" &&
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(
        triggerMessage.sender_identity_id,
      )
        ? triggerMessage.sender_identity_id
        : undefined;
    const recipientAddress =
      typeof triggerMessage.sender_address === "string" &&
      /^\+[1-9][0-9]{7,14}$/u.test(triggerMessage.sender_address)
        ? triggerMessage.sender_address
        : undefined;
    if (
      row.provider === "meta" &&
      (recipientIdentityId === undefined || recipientAddress === undefined)
    )
      throw new TypeError("AI inbound trigger has no trusted sender identity");
    const responseLocale =
      openingMenuRoute?.language ??
      latestMessageLocale(
        row.locale,
        triggerMessage.original_content_text ?? "",
        history
          .filter(
            (message) =>
              message.direction === "inbound" &&
              message.id !== triggerMessageId,
          )
          .map((message) => message.original_content_text ?? ""),
      );
    const orderedHistory = (
      memory.correctionsPresent
        ? history.filter((message) => message.id === triggerMessageId)
        : history
    ).toReversed();
    const noteRows = await transaction<
      { id: string; content_text: string; created_at: Date }[]
    >`
      SELECT note.id, left(note.body, 1200) AS content_text, note.created_at
      FROM crm.notes note
      WHERE note.contact_id=${row.contact_id}::uuid
      ORDER BY note.created_at DESC, note.id DESC LIMIT 8
    `;
    const previousConversations = await transaction<
      { summary: string; status: string; occurred_at: Date | null }[]
    >`
      SELECT left(coalesce(previous.last_message_preview, ''), 600) AS summary,
             previous.status, previous.last_message_at AS occurred_at
      FROM messaging.conversations previous
      WHERE previous.contact_id=${row.contact_id}::uuid
        AND previous.id<>${row.conversation_id}::uuid
      ORDER BY previous.last_message_at DESC NULLS LAST, previous.id DESC LIMIT 8
    `;
    const voiceSessions = await transaction<
      {
        session_id: string;
        status: string;
        answered: boolean | null;
        outcome: string | null;
        recording_object_id: string | null;
        transcript_object_id: string | null;
        occurred_at: Date;
      }[]
    >`
      SELECT session_id, status, answered, outcome, recording_object_id,
             transcript_object_id, created_at AS occurred_at
      FROM public.sessions
      WHERE contact_id=${row.contact_id}::uuid
      ORDER BY created_at DESC, session_id DESC LIMIT 8
    `;
    const ticketRows = await transaction<
      {
        id: string;
        title: string;
        summary: string;
        status: string;
        priority: string;
        occurred_at: Date;
      }[]
    >`
      SELECT id, title, left(coalesce(description, ''), 1200) AS summary,
             status, priority, updated_at AS occurred_at
      FROM crm.tasks
      WHERE contact_id=${row.contact_id}::uuid
      ORDER BY updated_at DESC, id DESC LIMIT 8
    `;
    const aiAuthored = await loadAiAuthoredContextIds(
      transaction,
      job.tenant_id,
      {
        noteIds: noteRows.map((note) => note.id),
        taskIds: ticketRows.map((ticket) => ticket.id),
      },
    );
    const excludedNotes = new Set(aiAuthored.noteIds);
    const excludedTasks = new Set(aiAuthored.taskIds);
    const notes = noteRows.filter((note) => !excludedNotes.has(note.id));
    const tickets = ticketRows.filter(
      (ticket) => !excludedTasks.has(ticket.id),
    );
    const intakes = await transaction<
      {
        status: NonNullable<AiWork["serviceIntake"]>["status"];
        collected_fields: unknown;
        national_id_hint: string | null;
        required_field_overrides: unknown;
        workflow_policy: unknown;
        has_photo: boolean;
        case_reference: string | null;
        customer_resolution_status: NonNullable<
          AiWork["serviceIntake"]
        >["customerResolutionStatus"];
      }[]
    >`
      SELECT intake.status, intake.collected_fields, intake.national_id_hint,
             intake.customer_resolution_status,
             intake.required_field_overrides, intake.workflow_policy, service.intake_has_photo(intake.id) AS has_photo, service_case.reference AS case_reference
      FROM service.intake_drafts intake
      LEFT JOIN service.cases service_case
        ON service_case.intake_draft_id=intake.id
       AND service_case.tenant_id=intake.tenant_id
      WHERE intake.conversation_id=${row.conversation_id}::uuid
        -- An intake from before Inbox removal belongs to the removed thread.
        -- A handed-off one otherwise escalated every reopened message to a
        -- person before the model was consulted.
        AND intake.created_at >= COALESCE((
          SELECT conversation.inbox_reopened_at
          FROM messaging.conversations conversation
          WHERE conversation.id=${row.conversation_id}::uuid
        ), '-infinity'::timestamptz)
      ORDER BY intake.updated_at DESC, intake.id DESC LIMIT 1
    `;
    const intake = intakes[0];
    const intakeFields = sanitizeIntakeProposal(intake?.collected_fields);
    const overridden = Object.entries(record(intake?.required_field_overrides))
      .filter(([, value]) => value === true)
      .map(([key]) => key);
    const serviceIntake =
      intake === undefined
        ? undefined
        : {
            status: intake.status,
            workflowPolicy: parseServiceWorkflowPolicy(intake.workflow_policy),
            fields: intakeFields,
            nationalIdMasked:
              intake.national_id_hint === null
                ? null
                : `••••${intake.national_id_hint}`,
            missingFields: [
              ...missingIntakeFields(
                {
                  ...intakeFields,
                  ...(intake.national_id_hint === null
                    ? {}
                    : { nationalId: "provided" }),
                },
                overridden as Parameters<typeof missingIntakeFields>[1],
                parseServiceWorkflowPolicy(intake.workflow_policy)
                  .requiredIntakeFields,
              ),
              ...(parseServiceWorkflowPolicy(intake.workflow_policy)
                .photoPolicy === "required" && !intake.has_photo
                ? ["photos"]
                : []),
            ],
            caseReference: intake.case_reference,
            customerResolutionStatus: intake.customer_resolution_status,
          };
    const missingProfileFields: ("name" | "email" | "company")[] = [];
    if (/^\+?[0-9 ()-]{7,}$/u.test(row.contact_name.trim()))
      missingProfileFields.push("name");
    if (row.contact_email === null) missingProfileFields.push("email");
    if (row.contact_company === null) missingProfileFields.push("company");
    const firstConversation = previousConversations.length === 0;
    const knownBeforeConversation =
      row.contact_created_at.getTime() <
        row.conversation_created_at.getTime() ||
      !firstConversation ||
      notes.length > 0 ||
      tickets.length > 0 ||
      voiceSessions.length > 0;
    return {
      agentVersionId: row.agent_version_id,
      modelConfigurationId: row.model_configuration_id,
      channelId: row.channel_id,
      contract,
      tenantDisplayName,
      ...(businessProfile === undefined ? {} : { businessProfile }),
      lead:
        lead === null
          ? null
          : {
              id: lead.id,
              revision: lead.revision,
              status: lead.status,
              collected: lead.fields
                .filter((field) => field.supersededAt === null)
                .map((field) => ({
                  key: field.key,
                  state: field.state,
                  value: field.normalizedValue,
                })),
              missingRequired: lead.completeness?.missing ?? [],
            },
      knowledge,
      contextBudgetEnabled: retrievalEnabled,
      ...(knowledgeChunks.length === 0 ? {} : { knowledgeChunks }),
      ...(memory.context === "" ? {} : { sessionMemory: memory.context }),
      ...(machine === null
        ? {}
        : { machineToolPrincipalId: machine.principalId }),
      opensTickets:
        hasCapability(contract.capabilities, "ticket.open") ||
        row.agent_implicit_ticketing,
      ownershipEpoch: row.ownership_epoch,
      conversationId: row.conversation_id,
      authorizedUserId: row.ai_enabled_by_user_id,
      contactId: row.contact_id,
      systemPrompt: row.system_prompt,
      ...(serviceIntake === undefined ? {} : { serviceIntake }),
      contactContext: {
        contact: {
          name: row.contact_name,
          email: row.contact_email,
          company: row.contact_company,
          lifecycleStatus: row.lifecycle_status,
        },
        identity: {
          matchedBy: "verified_whatsapp_identity",
          // This is the immutable inbound sender, not an arbitrary primary
          // contact phone or model-authored message metadata. It establishes
          // channel contactability, not consent or a different callback number.
          ...(recipientIdentityId === undefined ||
          recipientAddress === undefined
            ? {}
            : { channelPhone: recipientAddress }),
          knownBeforeConversation,
          firstConversation,
          missingProfileFields,
        },
        notes: notes.reverse().map((note) => ({
          text: note.content_text,
          occurredAt: note.created_at.toISOString(),
        })),
        previousConversations: (memory.correctionsPresent
          ? []
          : previousConversations
        )
          .reverse()
          .map((item) => ({
            summary: item.summary,
            status: item.status,
            occurredAt: item.occurred_at?.toISOString() ?? null,
          })),
        tickets: tickets.reverse().map((ticket) => ({
          id: ticket.id,
          title: ticket.title,
          summary: ticket.summary,
          status: ticket.status,
          priority: ticket.priority,
          occurredAt: ticket.occurred_at.toISOString(),
        })),
        voiceSessions: voiceSessions.reverse().map((session) => ({
          sessionId: session.session_id,
          status: session.status,
          answered: session.answered,
          outcome: session.outcome,
          recordingObjectId: session.recording_object_id,
          transcriptObjectId: session.transcript_object_id,
          occurredAt: session.occurred_at.toISOString(),
        })),
      },
      locale: responseLocale,
      provider: row.provider,
      ...(recipientIdentityId === undefined || recipientAddress === undefined
        ? {}
        : { recipientIdentityId, recipientAddress }),
      channelConfiguration,
      triggerMessageId,
      messages: orderedHistory.map((message) => ({
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

/** What is stored for this interaction's lead, after the latest action. */
type AiLeadState = AiWork["lead"];

/**
 * The provider request for one pass of the turn.
 *
 * Built from the resolved contract rather than from the job row, so the prompt,
 * the capabilities and the reviewed field list are the ones pinned at
 * admission. `lead` is present whenever the agent version pins a schema, even
 * before a lead exists: the agent needs to know what to ask.
 */
function aiRequestFor(
  work: AiWork,
  lead: AiLeadState,
  receipts: readonly WhatsAppActionReceipt[],
  options: { readonly replyOnly?: boolean } = {},
): WhatsAppAiRequest {
  const pinned = work.contract.leadFieldSchema;
  return {
    systemPrompt: work.contract.agentPrompt,
    locale: work.locale,
    capabilities:
      work.machineToolPrincipalId === undefined
        ? work.contract.capabilities.filter(
            (capability) => capability !== "ticket.open",
          )
        : work.contract.capabilities,
    ...(work.tenantDisplayName === null
      ? {}
      : { tenantDisplayName: work.tenantDisplayName }),
    ...(work.businessProfile === undefined
      ? {}
      : { businessProfile: work.businessProfile }),
    ...(pinned === null
      ? {}
      : {
          lead: {
            schema: pinned.schema,
            status: lead?.status ?? "new",
            collected: lead?.collected ?? [],
            missingRequired:
              lead?.missingRequired ??
              leadCompleteness(pinned.schema, []).missing,
          },
        }),
    ...(receipts.length === 0 ? {} : { actionReceipts: [...receipts] }),
    ...(options.replyOnly === true ? { replyOnly: true } : {}),
    ...(work.serviceIntake === undefined
      ? {}
      : { serviceIntake: work.serviceIntake }),
    contactContext: work.contactContext,
    knowledge: work.knowledge,
    contextBudgetEnabled: work.contextBudgetEnabled,
    ...(work.knowledgeChunks === undefined
      ? {}
      : { knowledgeChunks: work.knowledgeChunks }),
    ...(work.sessionMemory === undefined
      ? {}
      : { sessionMemory: work.sessionMemory }),
    messages: work.messages,
  };
}

/**
 * How many real lead actions one customer turn may take before the agent must
 * answer. Bounded so a model that keeps choosing actions cannot spend the
 * worker's budget or leave the customer without a reply.
 */
const maximumLeadActionsPerTurn = 3;

/** The lead actions the model may return, and the tool each one runs. */
const leadActionTools = {
  lead_save: "lead_save_fields",
  lead_finalize: "lead_finalize_collection",
  lead_follow_up: "lead_request_follow_up",
} as const satisfies Readonly<Record<string, LeadToolName>>;

type LeadActionName = keyof typeof leadActionTools;

function leadActionName(
  decision: WhatsAppAiDecision,
): LeadActionName | undefined {
  return decision.action === "lead_save" ||
    decision.action === "lead_finalize" ||
    decision.action === "lead_follow_up"
    ? decision.action
    : undefined;
}

function leadToolInput(
  decision: WhatsAppAiDecision & { readonly action: LeadActionName },
): Readonly<Record<string, unknown>> {
  if (decision.action === "lead_save")
    return { observations: decision.observations };
  if (decision.action === "lead_finalize") return { summary: decision.summary };
  return { note: decision.note };
}

/**
 * The commit a reply may point at, or nothing. A failed or absent action
 * leaves the ordinary gate in force, so an agent that tried and could not save
 * cannot tell the customer that it did.
 */
function committedRecordFrom(
  receipts: readonly WhatsAppActionReceipt[],
  lead: AiLeadState,
): CommittedRecord | undefined {
  if (lead === null || !receipts.some((receipt) => receipt.ok))
    return undefined;
  return { leadId: lead.id, revision: lead.revision };
}

function leadActionSummary(result: LeadToolResult): string {
  const changed = result.receipt?.changed ?? [];
  const missing = result.missingRequired;
  return [
    `revision ${String(result.receipt?.revision ?? 0)}`,
    changed.length === 0 ? "no change" : `committed ${changed.join(", ")}`,
    ...(result.rejected === undefined
      ? []
      : [`rejected ${result.rejected.map((item) => item.key).join(", ")}`]),
    missing.length === 0
      ? "nothing required is outstanding"
      : `still missing ${missing.join(", ")}`,
  ].join("; ");
}

/**
 * Run one lead action for real, in its own transaction, and report what
 * actually committed.
 *
 * Every guard the reply path applies is re-applied here, because this is a
 * side effect and the model chose it: the authorising operator must still be
 * active, the conversation must still be this AI generation's, and the trigger
 * must still be the current customer turn. The operation key is derived from
 * the job and the trigger message, so a retried job or a redelivered webhook
 * replays the same operation instead of writing a second time.
 *
 * A refusal is not an exception the caller swallows: it comes back as a failed
 * receipt, so the agent is told the truth and can say so.
 */
async function runWhatsAppLeadAction(
  sql: Sql,
  workerId: string,
  job: JobRow,
  work: AiWork,
  lead: AiLeadState,
  action: LeadActionName,
  decision: WhatsAppAiDecision & { readonly action: LeadActionName },
): Promise<{
  readonly receipt: WhatsAppActionReceipt;
  readonly lead: AiLeadState;
}> {
  const pinned = work.contract.leadFieldSchema;
  const tool = leadActionTools[action];
  // An action the published configuration never offered is a defect, not a
  // conversational outcome: the envelope did not advertise it, so retrying it
  // would only buy more provider calls. Fail the turn permanently and name the
  // reason, rather than answering the customer as though a choice was made.
  if (
    pinned === null ||
    !hasCapability(work.contract.capabilities, capabilityForTool(tool))
  )
    throw new WhatsAppAiProviderError("lead_action_not_permitted", false);
  try {
    return await withOwnedJobTransaction(
      sql,
      workerId,
      job,
      async (transaction) => {
        await setTenantContext(transaction, job.tenant_id);
        await requireOwnedJob(transaction, workerId, job);
        const machine = await authorizeMachineTool(
          transaction,
          job,
          workerId,
          capabilityForTool(tool),
          work,
        );
        if (machine === null)
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
        await requireCurrentTrigger(
          transaction,
          work.conversationId,
          work.triggerMessageId,
        );
        const binding: LeadBinding = {
          contactId: work.contactId,
          sourceChannel: "whatsapp",
          capabilities: work.contract.capabilities,
          ...(machine === null
            ? { actorUserId: work.authorizedUserId }
            : {
                executionClaim: {
                  jobId: job.id,
                  workerId,
                  claimToken: job.claim_token,
                },
              }),
          recordedBy: "agent",
          agentProfileVersionId: work.agentVersionId,
          conversationId: work.conversationId,
          conversationOwnershipEpoch: work.ownershipEpoch,
        };
        // The lead is created by the first real save, not by the greeting that
        // opened the conversation, and the key is the job's — a retry after a
        // lost commit reuses it rather than opening a second lead.
        const leadId =
          lead?.id ??
          (
            await ensureLeadForInteraction(transaction, binding, {
              operationKey: `whatsapp-ai-lead:${job.id}`,
              fieldSchemaId: pinned.id,
              fieldSchemaVersion: pinned.version,
              sourceMessageId: work.triggerMessageId,
              ...(work.contract.roleTitle === null
                ? {}
                : { businessObjective: work.contract.roleTitle }),
            })
          ).lead.id;
        const context: LeadToolContext = {
          leadId,
          // Stable across restarts and retries: the job and the customer turn it
          // answers, never a freshly generated call identifier.
          interactionKey: `whatsapp:${work.conversationId}`,
          turnKey: `${job.id}:${work.triggerMessageId}`,
          schema: pinned.schema,
          // Provenance the runtime can stand behind: the accepted message this
          // turn answers, and the messages of this conversation as the only
          // earlier turns the model is allowed to cite.
          sourceReferenceId: work.triggerMessageId,
          acceptedReferences: work.messages.map((message) => message.id),
        };
        const result = await executeLeadTool(
          transaction,
          binding,
          context,
          tool,
          leadToolInput(decision),
        );
        return {
          receipt: {
            action,
            ok: true,
            reference: result.receipt?.reference ?? null,
            detail: leadActionSummary(result),
          },
          lead: {
            id: leadId,
            revision: result.receipt?.revision ?? lead?.revision ?? 0,
            status: result.status,
            collected: result.collected,
            missingRequired: result.missingRequired,
          },
        };
      },
    );
  } catch (error) {
    // A rejected write is reported truthfully rather than failing the turn: the
    // customer still gets an answer, and it is an answer that cannot claim a
    // save happened. An unknown outcome is not treated as a rejection.
    if (
      error instanceof LeadToolError ||
      error instanceof TypeError ||
      (error instanceof Error &&
        [
          "LeadRevisionConflictError",
          "LeadOwnershipError",
          "LeadNotFoundError",
          "LeadAuthorizationError",
        ].includes(error.name))
    )
      return {
        receipt: {
          action,
          ok: false,
          reference: null,
          detail:
            error instanceof LeadToolError
              ? error.reason
              : "the action was refused",
        },
        lead,
      };
    throw error;
  }
}

function capabilityForTool(
  tool: LeadToolName,
): "lead.read" | "lead.write" | "lead.finalize" | "lead.follow_up" {
  switch (tool) {
    case "lead_read_state":
      return "lead.read";
    case "lead_save_fields":
      return "lead.write";
    case "lead_finalize_collection":
      return "lead.finalize";
    case "lead_request_follow_up":
      return "lead.follow_up";
  }
}

/**
 * Resolve the issue this AI action belongs to, before the action happens.
 *
 * Called only when the model has taken a real action — a handoff or a callback
 * — which is the point a genuine support issue is recognised. A greeting, a
 * redelivered webhook or a retried job does not open anything: the first two
 * never reach here, and the third repeats `attachmentKey` and attaches to the
 * ticket the earlier attempt already created.
 *
 * The subject is the model's own safe reason, never the customer's message
 * text, so a ticket list cannot become a place private message bodies leak to.
 */
async function ticketForAiAction(
  transaction: postgres.TransactionSql,
  work: AiWork,
  jobId: string,
  subjectSafe: string,
): Promise<string> {
  const source = await transaction<
    { id: string; locked_by: string; claim_token: string }[]
  >`
    SELECT id,locked_by,claim_token FROM ops.jobs
    WHERE id=${jobId}::uuid AND tenant_id=platform.current_tenant_id()
      AND reference_id=${work.conversationId}::uuid AND status='running'
      AND lease_expires_at>clock_timestamp()`;
  const owned = source[0];
  if (owned === undefined)
    throw new TypeError("ticket source claim unavailable");
  const machine = await authorizeMachineTool(
    transaction,
    owned,
    owned.locked_by,
    "ticket.open",
    work,
  );
  if (machine !== null) {
    const ticket = await transaction<{ id: string }[]>`
      SELECT platform.machine_ticket_open(${jobId}::uuid,${owned.locked_by},
        ${owned.claim_token}::uuid,${subjectSafe}) AS id`;
    if (ticket[0] === undefined)
      throw new TypeError("machine ticket unavailable");
    return ticket[0].id;
  }
  const attached = await openOrAttachTicket(
    transaction,
    work.authorizedUserId,
    {
      contactId: work.contactId,
      subject: subjectSafe,
      sourceChannel: "whatsapp",
      sourceConversationId: work.conversationId,
      attachmentKey: `whatsapp-ai-issue:${jobId}`,
    },
  );
  return attached.ticket.id;
}

async function createAiHandoff(
  transaction: postgres.TransactionSql,
  work: AiWork,
  jobId: string,
  reasonCode: WhatsAppAiEscalationReason,
  options: {
    readonly callbackOnly?: boolean;
    readonly sourceClaimToken: string;
  },
): Promise<string> {
  // Only the server's callback branches opt in; model reasons never grant it.
  const preserveAiOwnership =
    options.callbackOnly === true &&
    (await remediationEnabled(transaction, "handoff_resume"));
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
  const inbound = work.messages
    .filter((message) => message.role === "user")
    .map((message) => message.text.replace(/\s+/gu, " ").trim())
    .filter(
      (text) =>
        text.length >= 5 &&
        !explicitlyRequestsImmediateCall(text) &&
        !/^(?:hi|hello|hey|thanks|thank you|שלום|היי|תודה)[!?. ]*$/iu.test(
          text,
        ) &&
        !/(?:human|person|representative|agent|נציג|אדם|בן אדם)/iu.test(text),
    );
  // Prefer the most descriptive customer report over a final callback or
  // handoff command. The complete ordered evidence remains below.
  const issue =
    inbound.toSorted((left, right) => right.length - left.length)[0] ??
    safeReason;
  const history = work.messages
    .slice(-20)
    .map(
      (message) =>
        `${message.role === "user" ? "Customer" : "AI Agent"}: ${message.text.replace(/\s+/gu, " ").trim()}`,
    )
    .join("\n");
  const previous = work.contactContext.previousConversations
    .slice(-5)
    .map((item) => `- ${item.status}: ${item.summary}`)
    .join("\n");
  const voice = work.contactContext.voiceSessions
    .slice(-5)
    .map(
      (session) =>
        `- ${session.sessionId}: ${session.status}, answered=${String(session.answered)}${session.outcome ? `, outcome=${session.outcome}` : ""}, recording=${session.recordingObjectId ? "available" : "unavailable"}, transcript=${session.transcriptObjectId ? "available" : "unavailable"} at ${session.occurredAt}`,
    )
    .join("\n");
  const tickets = work.contactContext.tickets
    .slice(-8)
    .map(
      (ticket) =>
        `- ${ticket.id}: ${ticket.title} (${ticket.status}, ${ticket.priority}) at ${ticket.occurredAt}${ticket.summary ? ` — ${ticket.summary}` : ""}`,
    )
    .join("\n");
  const description = [
    `Customer: ${work.contactContext.contact.name}`,
    work.contactContext.contact.company
      ? `Company: ${work.contactContext.contact.company}`
      : null,
    `CRM status: ${work.contactContext.contact.lifecycleStatus}`,
    `Escalation reason: ${safeReason}`,
    `Current reported issue: ${issue}`,
    "",
    "WhatsApp evidence:",
    history || "No retained text messages.",
    "",
    "Previous conversation evidence:",
    previous || "No earlier conversation summary was found.",
    "",
    "Prior CRM tickets:",
    tickets || "No contact-linked ticket was found.",
    "",
    "CRM notes:",
    work.contactContext.notes
      .slice(-8)
      .map((note) => `- ${note.occurredAt}: ${note.text}`)
      .join("\n") || "No CRM note was found.",
    "",
    "Voice evidence:",
    voice || "No contact-linked voice session was found.",
    "",
    `Conversation reference: ${work.conversationId}`,
    `Handoff reference: ${receipt[0].id}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
    .slice(0, 20_000);
  const ticket = await transaction<{ id: string }[]>`
    INSERT INTO crm.tasks
      (tenant_id, contact_id, created_by_user_id, title, description, status, priority)
    SELECT platform.current_tenant_id(), ${work.contactId}::uuid,
           ${work.authorizedUserId}::uuid, ${`AI handoff · ${issue.slice(0, 180)}`},
           ${description}, 'todo',
           ${reasonCode === "emergency" || reasonCode === "safety" ? "urgent" : "high"}
    WHERE NOT EXISTS (
      SELECT 1 FROM audit.records
      WHERE action='conversation.ai_handoff_ticket'
        AND target_type='handoff' AND target_id=${receipt[0].id}::uuid
    )
    RETURNING id
  `;
  if (ticket[0] !== undefined) {
    const authoredNote = await transaction<{ id: string }[]>`
      INSERT INTO crm.notes (tenant_id, contact_id, author_user_id, body)
      VALUES (platform.current_tenant_id(), ${work.contactId}::uuid,
              ${work.authorizedUserId}::uuid, ${description})
      RETURNING id
    `;
    await transaction`
      INSERT INTO messaging.notifications
        (tenant_id, user_id, type, title, body, reference_type, reference_id)
      SELECT platform.current_tenant_id(), recipient.user_id,
             'handoff.requested', 'AI Agent needs a person',
             ${`Investigation complete: ${issue.slice(0, 220)}`},
             'handoff', ${receipt[0].id}::uuid
      FROM platform.current_tenant_notification_recipients() recipient
    `;
    await transaction`
      INSERT INTO audit.records
        (tenant_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (platform.current_tenant_id(), ${work.authorizedUserId}::uuid,
              'conversation.ai_handoff_ticket', 'handoff', ${receipt[0].id}::uuid,
              ${transaction.json({ taskId: ticket[0].id, noteId: authoredNote[0]?.id, sourceJobId: jobId, sourceClaimToken: options.sourceClaimToken })})
    `;
  }
  // Business tools require the current AI claim. Complete the ticket and
  // retain the one handoff acknowledgement before relinquishing that claim.
  // Doing this after the ownership transition made every principal-backed
  // escalation roll back with an authorization failure and no customer reply.
  const issueTicketId = work.opensTickets
    ? await ticketForAiAction(
        transaction,
        work,
        jobId,
        `AI handoff · ${safeReason}`,
      )
    : null;
  if (!preserveAiOwnership) {
    const authority = await transaction<{ authorized: boolean }[]>`
      SELECT platform.capture_principal_handoff_authority(
        ${jobId}::uuid,
        (SELECT locked_by FROM ops.jobs WHERE id=${jobId}::uuid),
        ${options.sourceClaimToken}::uuid,${receipt[0].id}::uuid) AS authorized
    `;
    if (authority[0]?.authorized !== true) throw new AiPrincipalDeniedError();
    await transaction`
      UPDATE messaging.conversations
      SET ownership_mode='human', ai_agent_profile_version_id=NULL,
          ai_enabled_by_user_id=NULL, ai_enabled_at=NULL,
          handoff_reason_safe=${safeReason}, updated_at=CURRENT_TIMESTAMP
      WHERE id=${work.conversationId}::uuid
    `;
  }
  await transaction`
    INSERT INTO audit.records
      (tenant_id, actor_user_id, action, target_type, target_id, metadata)
    VALUES (platform.current_tenant_id(), ${work.authorizedUserId}::uuid,
            'conversation.ai_handoff', 'conversation', ${work.conversationId}::uuid,
            ${transaction.json({ reasonCode, preserveAiOwnership })})
  `;
  // Only a ticketing agent turns its escalation into a support issue. The
  // handoff, the task and the human ownership above happen for every agent.
  if (issueTicketId === null) return receipt[0].id;
  // The escalation now also lives on the customer's ISSUE, beside the internal
  // work item rather than instead of it: `crm.tasks` keeps carrying the
  // operator's to-do and its existing notifications, deep links and audit, and
  // the ticket carries the customer-facing history the next channel reads.
  await recordTicketEvent(transaction, work.authorizedUserId, {
    ticketId: issueTicketId,
    kind: "escalation",
    actorKind: "ai",
    summarySafe: safeReason,
    evidence: {
      handoffId: receipt[0].id,
      conversationId: work.conversationId,
      ...(ticket[0] === undefined ? {} : { taskId: ticket[0].id }),
    },
  });
  // A human owns it from here. This is terminal for automatic work on the
  // issue, exactly as it already is for the conversation above.
  await setTicketHandlingMode(
    transaction,
    work.authorizedUserId,
    issueTicketId,
    "human",
    safeReason,
  );
  return receipt[0].id;
}

async function processWhatsAppAiReply(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
  openingMenuRoute?: OpeningMenuRoute,
): Promise<void> {
  let admittedWork: AiWork | undefined;
  let executionPrincipal: PrincipalAdmission | undefined;
  const recordPrincipalDenial = () =>
    withOwnedJobTransaction(sql, workerId, job, async (tx) => {
      await tx`SELECT platform.admit_messaging_execution_principal(${job.id}::uuid,${workerId},${job.claim_token}::uuid)`;
    });
  try {
    const work = await loadAiWork(sql, workerId, job, openingMenuRoute);
    admittedWork = work;
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await requireAiTurnOwnership(transaction, work);
      const anchored = await transaction`
        UPDATE ops.jobs SET admitted_agent_version_id=${work.agentVersionId}::uuid
        WHERE id=${job.id}::uuid AND
          (admitted_agent_version_id IS NULL OR admitted_agent_version_id=${work.agentVersionId}::uuid)
      `;
      if (anchored.count !== 1)
        throw new TypeError("AI job admission binding changed");
    });
    const requireExecutionPrincipal = async () => {
      const projection = await withOwnedJobTransaction(
        sql,
        workerId,
        job,
        async (tx) => {
          await requireAiTurnOwnership(tx, work);
          const rows = await tx<{ admission: unknown }[]>`
          SELECT platform.admit_messaging_execution_principal(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS admission`;
          const admission = parsePrincipalAdmission(rows[0]?.admission ?? null);
          const firstTool = work.contract.capabilities[0];
          if (
            (admission.mode === "principal" || admission.mode === "legacy") &&
            firstTool !== undefined
          )
            await authorizeMachineTool(tx, job, workerId, firstTool, work);
          return rows[0]?.admission ?? null;
        },
      );
      // The transaction above committed content-free invalid-principal evidence.
      // Throwing inside it would erase the operator alert.
      const admission = retainPrincipalAdmission(
        executionPrincipal,
        parsePrincipalAdmission(projection),
      );
      executionPrincipal ??= admission;
      return admission;
    };
    await requireExecutionPrincipal();
    if (work.provider === "simulator" && automation.simulatorEnabled !== true)
      throw new TypeError("simulation_disabled");
    const triggerText =
      work.messages.find((message) => message.id === work.triggerMessageId)
        ?.text ?? "";
    const explicitCallRequested = explicitlyRequestsImmediateCall(triggerText);
    // Explicit callback consent is a deterministic action and must not wait on
    // or depend on an LLM classification. The voice agent receives the bounded
    // conversation history when the durable callback job is dispatched.
    const identityConflict =
      work.serviceIntake?.customerResolutionStatus === "conflict";
    const intakeRequiresHuman = work.serviceIntake?.status === "handed_off";
    const receipts: WhatsAppActionReceipt[] = [];
    let leadState = work.lead;
    // Server-owned scope routing: a turn that only probes the model, asks for
    // prompts, other customers' data or another recipient, or asks for a
    // general-purpose task is answered with the approved response and never
    // reaches the model. Mixed turns still reach it; the output is validated.
    const scopeRoute =
      identityConflict || intakeRequiresHuman || explicitCallRequested
        ? null
        : classifyCustomerTurn(triggerText).route;
    const scopeResponse =
      scopeRoute === null
        ? null
        : approvedAgentResponse(
            scopeRoute,
            work.locale,
            work.tenantDisplayName,
          );
    const classifiedDecision: WhatsAppAiDecision =
      scopeResponse !== null
        ? { action: "reply", text: scopeResponse }
        : identityConflict || intakeRequiresHuman
          ? {
              action: "handoff",
              reasonCode: "insufficient_context",
              text: "",
            }
          : explicitCallRequested
            ? {
                action: "request_call",
                reasonCode: "call_requested",
                text: "",
              }
            : await (async () => {
                let provider = automation.aiProvider;
                let routedBeforeAttempt: (() => Promise<void>) | undefined;
                if (work.modelConfigurationId !== null) {
                  const readProjection = () =>
                    withOwnedJobTransaction(sql, workerId, job, async (tx) => {
                      await requireAiTurnOwnership(tx, work);
                      const projections = await tx<
                        {
                          route: {
                            binding: PublishedModelBinding;
                            configuration: ModelConfigurationRecord | null;
                          } | null;
                        }[]
                      >`
                      SELECT platform.current_published_model_route(${work.agentVersionId}::uuid,${work.authorizedUserId}::uuid,${work.channelId}::uuid) AS route`;
                      return projections[0]?.route ?? null;
                    });
                  const adapters = automation.modelRouting;
                  let admittedConfiguration:
                    ModelConfigurationRecord | undefined;
                  let admittedCredential: ResolvedModelCredential | undefined;
                  const readSealedCredential = async () => {
                    const configuration = admittedConfiguration;
                    const decrypt = adapters?.resolveSealedCredential;
                    if (!configuration?.credentialId || !decrypt) return null;
                    const envelope = await withOwnedJobTransaction(
                      sql,
                      workerId,
                      job,
                      async (tx) => {
                        await requireAiTurnOwnership(tx, work);
                        const projected = await tx<
                          { envelope: ModelCredentialEnvelope | null }[]
                        >`
                          SELECT platform.messaging_model_credential(
                            ${job.id}::uuid,${workerId},${job.claim_token}::uuid,
                            ${work.agentVersionId}::uuid,${configuration.id}::uuid,
                            ${configuration.credentialId}::uuid,${work.authorizedUserId}::uuid,
                            ${work.ownershipEpoch}::bigint,${work.triggerMessageId}::uuid) AS envelope`;
                        return projected[0]?.envelope ?? null;
                      },
                    );
                    if (
                      envelope?.tenantId !== job.tenant_id ||
                      envelope.modelConfigurationId !== configuration.id ||
                      envelope.credentialId !== configuration.credentialId ||
                      envelope.provider !== configuration.provider
                    )
                      return null;
                    return decrypt(envelope);
                  };
                  const resolveCredential =
                    adapters?.resolveCredential ??
                    (adapters?.resolveSealedCredential === undefined
                      ? undefined
                      : async (
                          tenantId: string,
                          credentialId: string,
                          provider: "openai" | "gemini",
                        ) => {
                          const configuration = admittedConfiguration;
                          if (
                            tenantId !== job.tenant_id ||
                            credentialId !== configuration?.credentialId ||
                            provider !== configuration.provider
                          )
                            return null;
                          const resolved = await readSealedCredential();
                          if (resolved !== null)
                            admittedCredential ??= resolved;
                          return resolved;
                        });
                  const reserveDailyAttempt = async (
                    tenantId: string,
                    configurationId: string,
                    limit: number,
                  ): Promise<boolean> => {
                    const snapshot = admittedConfiguration;
                    if (
                      !snapshot ||
                      tenantId !== job.tenant_id ||
                      snapshot.tenantId !== tenantId ||
                      snapshot.id !== configurationId ||
                      snapshot.dailyRequestLimit !== limit
                    )
                      return false;
                    return withOwnedJobTransaction(
                      sql,
                      workerId,
                      job,
                      async (tx) => {
                        await requireAiTurnOwnership(tx, work);
                        const rows = await tx<{ reserved: boolean }[]>`
                        SELECT agents.reserve_messaging_model_attempt(${job.id}::uuid,${workerId},${job.claim_token}::uuid,
                          ${work.agentVersionId}::uuid,${configurationId}::uuid,${work.authorizedUserId}::uuid,
                          ${work.ownershipEpoch}::bigint,${work.triggerMessageId}::uuid,${JSON.stringify(snapshot)}::text::jsonb) AS reserved`;
                        return rows[0]?.reserved === true;
                      },
                    );
                  };
                  const route = await resolveTrustedModelRoute(
                    {
                      tenantId: job.tenant_id,
                      agentVersionId: work.agentVersionId,
                      actorUserId: work.authorizedUserId,
                      channel: "whatsapp",
                    },
                    {
                      readPublishedBinding: async () =>
                        (await readProjection())?.binding ?? null,
                      readConfiguration: async (tenantId, configurationId) => {
                        const configuration = (await readProjection())
                          ?.configuration;
                        if (
                          configuration?.tenantId !== tenantId ||
                          configuration.id !== configurationId
                        )
                          return null;
                        admittedConfiguration ??= configuration;
                        return configuration;
                      },
                      ...(resolveCredential === undefined
                        ? {}
                        : { resolveCredential }),
                      reserveDailyAttempt:
                        adapters?.reserveDailyAttempt ?? reserveDailyAttempt,
                    },
                  );
                  if (route.status !== "configured" || !adapters)
                    throw new WhatsAppAiProviderError(
                      "model_configuration_unavailable",
                      false,
                    );
                  provider = adapters.createProvider(route);
                  routedBeforeAttempt = async () => {
                    if (
                      adapters.resolveCredential === undefined &&
                      adapters.resolveSealedCredential !== undefined
                    ) {
                      // Re-read canonical authority even on a decrypt-cache hit.
                      // An admitted request fails closed on mid-turn key rotation.
                      const fresh = await readSealedCredential();
                      if (
                        fresh === null ||
                        fresh.fingerprint !== admittedCredential?.fingerprint
                      )
                        throw new WhatsAppAiProviderError(
                          "model_credential_changed",
                          false,
                        );
                    }
                    // Rejected credential changes are not physical model attempts.
                    await route.beforeAttempt();
                  };
                }
                if (provider === undefined)
                  throw new TypeError("WhatsApp AI is disabled");
                // A turn may take a few real actions and must still end in
                // something the customer can read, so the budget is bounded and
                // the last pass is offered no further actions.
                for (let round = 0; ; round += 1) {
                  const last = round >= maximumLeadActionsPerTurn;
                  await automation.beforeModelAttempt?.();
                  const proposed = await provider.decide(
                    aiRequestFor(work, leadState, receipts, {
                      ...(last ? { replyOnly: true } : {}),
                    }),
                    async (usage) => {
                      if (provider.accountingMode === "attempts") return;
                      const usageId = usage.eventId ?? randomUUID();
                      // Accounting belongs to the trusted claimed tenant even
                      // if ownership is lost while the provider bills a call.
                      // It grants no permission to perform business actions.
                      await sql.begin(async (transaction) => {
                        await setTenantContext(transaction, job.tenant_id);
                        await transaction`SELECT agents.record_messaging_usage(${usageId}::uuid, ${usage.inputTokens}, ${usage.outputTokens}, ${usage.latencyMs})`;
                      });
                    },
                    async (attempt) => {
                      if (automation.modelAttemptRecorder === undefined)
                        throw new Error("model attempt recorder unavailable");
                      await automation.modelAttemptRecorder(
                        {
                          tenantId: job.tenant_id,
                          jobId: job.id,
                          agentVersionId: work.agentVersionId,
                        },
                        attempt,
                      );
                    },
                    async () => {
                      await automation.beforeModelAttempt?.();
                      await requireExecutionPrincipal();
                      await withOwnedJobTransaction(
                        sql,
                        workerId,
                        job,
                        async (tx) => {
                          await requireAiTurnOwnership(tx, work);
                        },
                      );
                      await routedBeforeAttempt?.();
                    },
                  );
                  const action = leadActionName(proposed);
                  if (action === undefined) {
                    const previous = work.messages.at(-2);
                    return deferUnconfirmedContextHandoff(
                      proposed,
                      triggerText,
                      previous?.role === "assistant" ? previous.text : "",
                    );
                  }
                  if (last)
                    throw new WhatsAppAiProviderError(
                      "ai_invalid_output",
                      false,
                    );
                  const executed = await runWhatsAppLeadAction(
                    sql,
                    workerId,
                    job,
                    work,
                    leadState,
                    action,
                    proposed as WhatsAppAiDecision & {
                      readonly action: typeof action;
                    },
                  );
                  receipts.push(executed.receipt);
                  leadState = executed.lead;
                }
              })();
    const decision = enforceStandaloneCallbackConsent(
      classifiedDecision,
      explicitCallRequested,
    );
    await requireExecutionPrincipal();
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job);
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
      // Hold the canonical binding/principal SHARE locks through reply and
      // outbound creation. An independent revocation cannot commit between
      // this check and those writes.
      const principalRows = await transaction<{ admission: unknown }[]>`
        SELECT platform.admit_messaging_execution_principal(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS admission`;
      retainPrincipalAdmission(
        executionPrincipal,
        parsePrincipalAdmission(principalRows[0]?.admission ?? null),
      );
      const firstTool = work.contract.capabilities[0];
      if (firstTool !== undefined)
        await authorizeMachineTool(transaction, job, workerId, firstTool, work);
      const grounded = groundAiReply(
        decision,
        await eligibleFacts(transaction, work.agentVersionId),
        work.locale,
        await recentDeliveredReplies(transaction, work.conversationId),
        triggerText,
        // Only a write that actually committed in this turn lets the reply say
        // anything was recorded, and the revision it committed at travels with
        // the message so delivery can check the same fact.
        committedRecordFrom(receipts, leadState),
      );
      let responseText = grounded.text;
      let evidence:
        | GroundedReply["evidence"]
        | {
            kind: "receipt";
            operation: "handoff" | "callback" | "ticket";
            resourceId: string;
          }
        | {
            kind: "scope_policy";
            route: string;
            policyVersion: string;
          } = grounded.evidence;
      if (scopeRoute !== null && scopeResponse !== null) {
        responseText = scopeResponse;
        evidence = {
          kind: "scope_policy",
          route: scopeRoute,
          policyVersion: agentScopePolicyVersion,
        };
      }
      const modelScope =
        scopeRoute === null && decision.action === "reply"
          ? validateAgentOutput(decision.text)
          : { allowed: true, category: null };
      if (scopeRoute !== null || !modelScope.allowed)
        // Sanitized security record: the category and policy, never the
        // customer's words or the rejected model text.
        await transaction`
          INSERT INTO audit.records
            (tenant_id, actor_user_id, action, target_type, target_id, metadata)
          VALUES (platform.current_tenant_id(), ${work.authorizedUserId}::uuid,
                  ${scopeRoute !== null ? "agent.scope.routed" : "agent.scope.output_rejected"},
                  'conversation', ${work.conversationId}::uuid,
                  ${transaction.json({
                    policyVersion: agentScopePolicyVersion,
                    channel: "whatsapp",
                    category: scopeRoute ?? modelScope.category,
                    triggerMessageId: work.triggerMessageId,
                  })})
        `;
      if (decision.action === "ticket_open") {
        if (!work.opensTickets) throw new AiPrincipalDeniedError();
        const machine = await authorizeMachineTool(
          transaction,
          job,
          workerId,
          "ticket.open",
          work,
        );
        if (machine === null) throw new AiPrincipalDeniedError();
        const ticketId = await ticketForAiAction(
          transaction,
          work,
          job.id,
          decision.subject,
        );
        evidence = {
          kind: "receipt",
          operation: "ticket",
          resourceId: ticketId,
        };
        responseText = actionReceiptReply("ticket", work.locale);
      }
      let automaticCallQueued = false;
      if (decision.action === "handoff" && !explicitCallRequested) {
        const resourceId = await createAiHandoff(
          transaction,
          work,
          job.id,
          decision.reasonCode,
          { sourceClaimToken: job.claim_token },
        );
        evidence = { kind: "receipt", operation: "handoff", resourceId };
        responseText = actionReceiptReply("handoff", work.locale);
      }
      if (decision.action === "request_call" || explicitCallRequested) {
        if (
          automation.automaticCallsEnabled === true &&
          automation.automaticCallProvider !== undefined &&
          explicitCallRequested
        ) {
          try {
            // The issue exists BEFORE the dial is admitted, so every attempt —
            // including the retries and the ones that never connect — lands on
            // one ticket instead of creating a trail of orphaned records. Only
            // a ticketing agent has an issue to land them on; the callback
            // itself belongs to every agent the customer asked to call back.
            const ticketId = work.opensTickets
              ? await ticketForAiAction(
                  transaction,
                  work,
                  job.id,
                  "Customer requested a callback",
                )
              : null;
            const receipt = await queueWhatsAppAutomaticCall(
              transaction,
              work.authorizedUserId,
              work.conversationId,
              work.triggerMessageId,
              `whatsapp-ai-call:${job.id}`,
            );
            if (ticketId !== null) {
              // Voice takes the issue while the call is outstanding. The
              // messaging worker still persists inbound WhatsApp for this
              // conversation; it must not run a second AI conversation about
              // the same problem underneath the call.
              await setTicketHandlingMode(
                transaction,
                work.authorizedUserId,
                ticketId,
                "ai_voice",
                "Callback admitted; voice owns the issue.",
              );
              // The attempt row exists before the dial is placed, so an
              // accepted call whose response is lost has something to
              // reconcile against and the post-call pipeline has somewhere to
              // land.
              const attempt = await openTicketCallAttempt(transaction, {
                ticketId,
                jobId: receipt.jobId,
                handoffId: receipt.handoffId,
                assuranceLevel: "channel_associated",
              });
              await recordTicketEvent(transaction, work.authorizedUserId, {
                ticketId,
                kind: "call_attempt",
                actorKind: "ai",
                summarySafe:
                  "Callback queued after an explicit customer request.",
                evidence: {
                  jobId: receipt.jobId,
                  flowId: receipt.flowId,
                  flowVersion: receipt.flowVersion,
                  attemptId: attempt.id,
                  attemptNumber: attempt.attemptNumber,
                },
              });
            }
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
                        reasonCode: "call_requested",
                        routing: "automatic",
                      })})
            `;
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            const resourceId = await createAiHandoff(
              transaction,
              work,
              job.id,
              decision.action === "request_call"
                ? decision.reasonCode
                : "call_requested",
              { callbackOnly: true, sourceClaimToken: job.claim_token },
            );
            evidence = { kind: "receipt", operation: "handoff", resourceId };
            responseText = actionReceiptReply("handoff", work.locale);
          }
        } else {
          const resourceId = await createAiHandoff(
            transaction,
            work,
            job.id,
            decision.action === "request_call"
              ? decision.reasonCode
              : "call_requested",
            { callbackOnly: true, sourceClaimToken: job.claim_token },
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
            ...(work.recipientIdentityId === undefined ||
            work.recipientAddress === undefined
              ? {}
              : {
                  recipientIdentityId: work.recipientIdentityId,
                  recipientAddress: work.recipientAddress,
                }),
            senderUserId: work.authorizedUserId,
            senderType: "agent",
            text: responseText,
          },
          work.channelConfiguration,
        );
        const captured = await transaction<{ authorized: boolean }[]>`
          SELECT platform.capture_outbound_execution_authority(
            ${job.id}::uuid,${workerId},${job.claim_token}::uuid,
            ${outbound.requestId}::uuid) AS authorized`;
        if (captured[0]?.authorized !== true)
          throw new AiPrincipalDeniedError();
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
          automaticCallQueued
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
    let failure: unknown = error;
    // A finalization-race denial rolled back its transaction-local alert.
    // Re-admit in a separate freshly fenced transaction to retain evidence.
    if (error instanceof AiPrincipalDeniedError) await recordPrincipalDenial();
    if (
      error instanceof WhatsAppAiProviderError &&
      admittedWork !== undefined
    ) {
      try {
        if (
          await queueModelFailureRecovery(
            sql,
            workerId,
            job,
            admittedWork,
            automation,
            { principalAdmission: executionPrincipal },
          )
        )
          return;
      } catch (recoveryError) {
        if (
          !(recoveryError instanceof AiPrincipalDeniedError) &&
          (!(recoveryError instanceof TypeError) ||
            ![
              "AI conversation ownership changed",
              "AI inbound trigger superseded",
            ].includes(recoveryError.message))
        )
          throw recoveryError;
        // A manual takeover is a terminal turn cancellation, not a failed
        // recovery that should terminate the worker or produce a new reply.
        failure = recoveryError;
      }
    }
    const reason =
      failure instanceof WhatsAppAiProviderError
        ? failure.code
        : failure instanceof TypeError
          ? failure.message
          : "AI reply failed";
    const permanent =
      failure instanceof TypeError ||
      (failure instanceof WhatsAppAiProviderError && !failure.retryable);
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent) {
        await transaction`
          UPDATE ops.jobs SET max_attempts=attempts
          WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
        `;
      }
      await transaction`
        SELECT ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${reason}, 10)
      `;
    });
  }
}

async function requireAiTurnOwnership(
  transaction: postgres.TransactionSql,
  work: AiWork,
): Promise<void> {
  if (await digitalServiceFormPending(transaction, work.conversationId))
    throw new TypeError("digital_form_pending");
  await transaction`SELECT set_config('app.current_user',${work.authorizedUserId},true)`;
  const owned = await transaction<{ id: string }[]>`
    SELECT c.id FROM messaging.conversations c
    JOIN messaging.channels channel ON channel.id=c.channel_id AND channel.tenant_id=c.tenant_id
    JOIN agents.agent_profile_versions a ON a.id=c.ai_agent_profile_version_id AND a.tenant_id=c.tenant_id
    WHERE c.id=${work.conversationId}::uuid AND c.ownership_mode='ai'
      AND c.removed_from_inbox_at IS NULL AND c.ownership_epoch=${work.ownershipEpoch}::bigint
      AND c.ai_enabled_by_user_id=${work.authorizedUserId}::uuid
      AND a.id=${work.agentVersionId}::uuid AND a.published_at IS NOT NULL
      AND a.validation_status='valid' AND channel.status='active'
      AND platform.messaging_ai_actor_authorized(c.ai_enabled_by_user_id)
    FOR UPDATE OF c
  `;
  if (owned.length !== 1)
    throw new TypeError("AI conversation ownership changed");
  await requireCurrentTrigger(
    transaction,
    work.conversationId,
    work.triggerMessageId,
  );
}

async function storedUnsupportedMedia(
  transaction: postgres.TransactionSql,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  const rows = await transaction<{ payload: unknown }[]>`
    SELECT event.payload FROM messaging.messages message
    JOIN messaging.conversations c ON c.id=message.conversation_id AND c.tenant_id=message.tenant_id
    JOIN messaging.channels channel ON channel.id=c.channel_id AND channel.tenant_id=c.tenant_id
    JOIN ops.inbound_events event ON event.tenant_id=message.tenant_id AND event.provider=message.provider
      AND event.provider_account_id=channel.provider_account_id
      AND event.payload->>'providerMessageId'=message.provider_message_id
    WHERE message.id=${messageId}::uuid AND c.id=${conversationId}::uuid
      AND message.direction='inbound' AND message.status='received'
      AND (message.structured_content->>'retrievalStatus'='unsupported'
        OR (message.content_type='video' AND message.structured_content->>'agentMediaStatus'='unsupported'))
      AND channel.provider='meta' AND channel.status='active'
  `;
  const envelope = parseStoredWhatsAppEnvelope(rows[0]?.payload);
  return (
    envelope !== undefined &&
    (unsupportedInboundMedia(envelope) || envelope.contentType === "video")
  );
}

async function processUnsupportedMediaReply(
  sql: Sql,
  workerId: string,
  job: JobRow,
  automation: MessagingAutomationOptions,
): Promise<void> {
  try {
    const work = await loadAiWork(sql, workerId, job);
    const pinned = record(job.payload);
    if (
      pinned.ownershipEpoch !== work.ownershipEpoch ||
      pinned.agentVersionId !== work.agentVersionId ||
      pinned.authorizedUserId !== work.authorizedUserId
    )
      throw new TypeError("unsupported media ownership changed");
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await requireTenantFeatures(transaction, ["whatsapp"]);
      await requireAiTurnOwnership(transaction, work);
      if (
        !(await remediationEnabled(transaction, "no_silence")) ||
        !(await storedUnsupportedMedia(
          transaction,
          work.conversationId,
          work.triggerMessageId,
        ))
      )
        throw new TypeError("unsupported media admission withdrawn");
      const text = unsupportedMediaReply(work.locale);
      const outbound = await queueWhatsAppOutbound(
        transaction,
        {
          conversationId: work.conversationId,
          explicitlyConfirmed: true,
          idempotencyKey: `unsupported-media:${work.triggerMessageId}`,
          kind: "text",
          provider: work.provider,
          realProviderEnabled: automation.realWhatsAppEnabled === true,
          ...(work.recipientIdentityId === undefined ||
          work.recipientAddress === undefined
            ? {}
            : {
                recipientIdentityId: work.recipientIdentityId,
                recipientAddress: work.recipientAddress,
              }),
          senderUserId: work.authorizedUserId,
          senderType: "agent",
          text,
        },
        work.channelConfiguration,
      );
      await transaction`UPDATE messaging.messages SET provider_payload=coalesce(provider_payload,'{}'::jsonb)||
        ${transaction.json({ aiGrounding: { schemaVersion: "1.0", agentVersionId: work.agentVersionId, triggerMessageId: work.triggerMessageId, locale: work.locale, textSha256: factDigest(text), evidence: { kind: "unsupported_media" } } })}::jsonb
        WHERE id=${outbound.messageId}::uuid`;
      await finishJob(transaction, job, workerId);
    });
  } catch (error) {
    await withOwnedJobTransaction(sql, workerId, job, async (tx) => {
      await setTenantContext(tx, job.tenant_id);
      if (error instanceof TypeError)
        await tx`UPDATE ops.jobs SET max_attempts=attempts WHERE id=${job.id}::uuid`;
      await tx`SELECT ops.fail_messaging_job_claim(${job.id}::uuid,${workerId},${job.claim_token}::uuid,
        ${error instanceof TypeError ? error.message : "unsupported media reply failed"},10)`;
    });
  }
}

/** Atomically retain customer acknowledgement, operator work and alert outbox. */
async function queueModelFailureRecovery(
  sql: Sql,
  workerId: string,
  job: JobRow,
  work: AiWork,
  automation: MessagingAutomationOptions,
  options: {
    readonly transaction?: postgres.TransactionSql;
    readonly finish?: boolean;
    readonly principalAdmission?: PrincipalAdmission | undefined;
  } = {},
): Promise<boolean> {
  const perform = async (
    transaction: postgres.TransactionSql,
  ): Promise<boolean> => {
    if (!(await remediationEnabled(transaction, "no_silence"))) return false;
    await requireTenantFeatures(transaction, ["whatsapp"]);
    await requireAiTurnOwnership(transaction, work);
    if (options.principalAdmission !== undefined) {
      const rows = await transaction<{ admission: unknown }[]>`
        SELECT platform.admit_messaging_execution_principal(
          ${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS admission`;
      retainPrincipalAdmission(
        options.principalAdmission,
        parsePrincipalAdmission(rows[0]?.admission ?? null),
      );
    }
    const existing = await transaction<{ task_id: string }[]>`
      SELECT metadata->>'taskId' AS task_id FROM audit.records
      WHERE action='conversation.ai_model_failure' AND target_type='job'
        AND target_id=${job.id}::uuid
    `;
    let taskId = existing[0]?.task_id;
    if (taskId === undefined) {
      const tasks = await transaction<{ id: string }[]>`
        INSERT INTO crm.tasks(tenant_id,contact_id,created_by_user_id,title,description,status,priority)
        VALUES(platform.current_tenant_id(),${work.contactId}::uuid,${work.authorizedUserId}::uuid,
          'AI reply needs operator follow-up',
          ${`The AI could not produce a safe reply. Review conversation ${work.conversationId}. No business action is claimed.`},
          'todo','high') RETURNING id
      `;
      taskId = tasks[0]?.id;
      if (taskId === undefined)
        throw new Error("AI failure task was not created");
      await transaction`
        INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
        VALUES(platform.current_tenant_id(),${work.authorizedUserId}::uuid,
          'conversation.ai_model_failure','job',${job.id}::uuid,
          ${transaction.json({ taskId, conversationId: work.conversationId, triggerMessageId: work.triggerMessageId, sourceJobId: job.id, sourceClaimToken: job.claim_token })})
      `;
      await transaction`
        INSERT INTO messaging.notifications(tenant_id,user_id,type,title,body,reference_type,reference_id)
        SELECT platform.current_tenant_id(),recipient.user_id,'whatsapp.ai.failure',
          'AI reply needs operator follow-up','A customer turn needs a person to review it.',
          'conversation',${work.conversationId}::uuid
        FROM platform.current_tenant_notification_recipients() recipient
      `;
    }
    await transaction`
      INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,
        idempotency_key,max_attempts,priority)
      VALUES(platform.current_tenant_id(),'messaging','whatsapp.operator.alert','task',${taskId}::uuid,
        ${transaction.json({ taskId, conversationId: work.conversationId, sourceJobId: job.id, reasonCode: "ai_model_failure" })},
        ${`ai-failure-alert:${job.id}`},5,100) ON CONFLICT DO NOTHING
    `;
    const text = modelFailureReply(work.locale);
    const outbound = await queueWhatsAppOutbound(
      transaction,
      {
        conversationId: work.conversationId,
        explicitlyConfirmed: true,
        idempotencyKey: `ai-fallback:${job.id}`,
        kind: "text",
        provider: work.provider,
        realProviderEnabled: automation.realWhatsAppEnabled === true,
        ...(work.recipientIdentityId === undefined ||
        work.recipientAddress === undefined
          ? {}
          : {
              recipientIdentityId: work.recipientIdentityId,
              recipientAddress: work.recipientAddress,
            }),
        senderUserId: work.authorizedUserId,
        senderType: "agent",
        text,
      },
      work.channelConfiguration,
    );
    await transaction`
      UPDATE messaging.messages SET provider_payload=coalesce(provider_payload,'{}'::jsonb) ||
        ${transaction.json({
          aiGrounding: {
            schemaVersion: "1.0",
            agentVersionId: work.agentVersionId,
            triggerMessageId: work.triggerMessageId,
            locale: work.locale,
            textSha256: factDigest(text),
            evidence: { kind: "failure_fallback", taskId, sourceJobId: job.id },
          },
        })}::jsonb
      WHERE id=${outbound.messageId}::uuid
    `;
    if (job.job_type === "whatsapp.ai.reply") {
      const authority = await transaction<{ authorized: boolean }[]>`
        SELECT platform.capture_outbound_execution_authority(
          ${job.id}::uuid,${workerId},${job.claim_token}::uuid,
          ${outbound.requestId}::uuid) AS authorized`;
      if (authority[0]?.authorized !== true) throw new AiPrincipalDeniedError();
    }
    if (options.finish !== false) await finishJob(transaction, job, workerId);
    return true;
  };
  return options.transaction === undefined
    ? withOwnedJobTransaction(sql, workerId, job, perform)
    : perform(options.transaction);
}

async function processOperatorAlert(
  sql: Sql,
  workerId: string,
  job: JobRow,
  provider: OperatorAlertProvider | undefined,
): Promise<void> {
  const payload = record(job.payload);
  if (
    !uuid(payload.taskId) ||
    !uuid(payload.conversationId) ||
    !uuid(payload.sourceJobId) ||
    payload.reasonCode !== "ai_model_failure"
  )
    throw new TypeError("invalid operator alert");
  const taskId = payload.taskId,
    conversationId = payload.conversationId,
    sourceJobId = payload.sourceJobId;
  const eligible = await withOwnedJobTransaction(
    sql,
    workerId,
    job,
    async (transaction) => {
      const rows = await transaction<{ id: string }[]>`
      SELECT task.id FROM crm.tasks task
      JOIN audit.records a ON a.tenant_id=task.tenant_id
        AND a.action='conversation.ai_model_failure' AND a.target_type='job'
        AND a.target_id=${sourceJobId}::uuid
        AND a.metadata->>'taskId'=task.id::text
        AND a.metadata->>'conversationId'=${conversationId}
      WHERE task.id=${taskId}::uuid AND task.status IN ('todo','in_progress')
    `;
      if (rows.length === 0) {
        await finishJob(transaction, job, workerId);
        return false;
      }
      if (provider === undefined) {
        // An unconfigured operator destination is not a successful alert. Keep
        // durable work pending without burning attempts or retriggering the LLM.
        await transaction`
        UPDATE ops.jobs SET status='queued',attempts=GREATEST(attempts-1,0),
          available_at=clock_timestamp()+interval '60 seconds',locked_by=NULL,locked_at=NULL,
          lease_expires_at=NULL,last_error_safe='operator_alert_route_unconfigured'
        WHERE id=${job.id}::uuid
      `;
        return false;
      }
      return true;
    },
  );
  if (!eligible || provider === undefined) return;
  try {
    const delivered = await provider.deliver({
      idempotencyKey: `operator-alert:${job.id}`,
      tenantId: job.tenant_id,
      taskId,
      conversationId,
      reasonCode: "ai_model_failure",
    });
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await transaction`
        INSERT INTO audit.records(tenant_id,actor_service,action,target_type,target_id,metadata)
        VALUES(platform.current_tenant_id(),'messaging-worker','operator.alert.delivered',
          'job',${job.id}::uuid,${transaction.json({ providerReference: delivered.reference })})
      `;
      await finishJob(transaction, job, workerId);
    });
  } catch {
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await transaction`
        SELECT ops.fail_messaging_job_claim(${job.id}::uuid,${workerId},${job.claim_token}::uuid,
          'operator_alert_delivery_failed',5)
      `;
    });
  }
}

interface AutomaticCallPayload {
  readonly agentVersionId: string;
  readonly canonicalFlowVersionId: string;
  readonly ownershipEpoch: string;
  readonly actorUserId: string;
  readonly contactIdentityId: string;
  readonly contactId: string;
  readonly conversationId: string;
  readonly destination: string;
  readonly flowId: string;
  readonly flowVersion: number;
  readonly handoffId: string;
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
    typeof payload.contactIdentityId !== "string" ||
    !uuid.test(payload.contactIdentityId) ||
    typeof payload.contactId !== "string" ||
    !uuid.test(payload.contactId) ||
    typeof payload.conversationId !== "string" ||
    !uuid.test(payload.conversationId) ||
    typeof payload.destination !== "string" ||
    !/^\+[1-9][0-9]{7,14}$/u.test(payload.destination) ||
    typeof payload.flowId !== "string" ||
    !uuid.test(payload.flowId) ||
    typeof payload.handoffId !== "string" ||
    !uuid.test(payload.handoffId) ||
    typeof payload.flowVersion !== "number" ||
    !Number.isInteger(payload.flowVersion) ||
    payload.flowVersion < 1 ||
    typeof payload.triggerMessageId !== "string" ||
    !uuid.test(payload.triggerMessageId)
  )
    throw new TypeError("automatic call payload is invalid");
  return payload as unknown as AutomaticCallPayload;
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
  return withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireTenantFeatures(transaction, ["whatsapp", "voice"]);
    await requireOwnedJob(transaction, workerId, job);
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
        sender_address: string;
        trigger_text: string;
        agent_version_id: string;
      }[]
    >`
      SELECT origin.sender_address, trigger.content_text AS trigger_text,
             agent.id AS agent_version_id
      FROM messaging.conversations conversation
      JOIN messaging.channels channel
        ON channel.id=conversation.channel_id
       AND channel.tenant_id=conversation.tenant_id
       AND channel.provider='meta'
       AND channel.status='active'
      JOIN ops.jobs authorized_job
        ON authorized_job.id=${job.id}::uuid
       AND authorized_job.tenant_id=conversation.tenant_id
       AND authorized_job.queue='messaging'
       AND authorized_job.job_type='whatsapp.ai.call'
       AND authorized_job.reference_type='conversation'
       AND authorized_job.reference_id=conversation.id
       AND authorized_job.callback_trigger_message_id=${payload.triggerMessageId}::uuid
       AND authorized_job.callback_sender_identity_id=${payload.contactIdentityId}::uuid
       AND authorized_job.callback_destination=${payload.destination}
      JOIN agents.agent_profile_versions agent
        ON agent.id=${payload.agentVersionId}::uuid AND agent.tenant_id=conversation.tenant_id
        AND agent.published_at IS NOT NULL
        AND agent.validation_status='valid' AND 'voice'=ANY(agent.channel_capabilities)
      JOIN automation.flow_versions canonical
        ON canonical.id=${payload.canonicalFlowVersionId}::uuid AND canonical.tenant_id=conversation.tenant_id
        AND canonical.agent_profile_version_id=conversation.ai_agent_profile_version_id
        AND canonical.published_at IS NOT NULL
        AND canonical.validation_status='valid'
        AND platform.approved_flow_for_channel(canonical.id,agent.id,'voice')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(canonical.definition->'nodes') node
          WHERE node->>'type'='voice.call'
            AND node#>>'{configuration,flowId}'=${payload.flowId}
            AND node#>>'{configuration,flowVersion}'=${String(payload.flowVersion)}
            AND (
              (node#>>'{configuration,agentVersionId}' IS NULL
               AND agent.id=conversation.ai_agent_profile_version_id)
              OR node#>>'{configuration,agentVersionId}'=agent.id::text
            ))
      JOIN automation.flow_definitions canonical_definition
        ON canonical_definition.id=canonical.flow_definition_id
       AND canonical_definition.tenant_id=canonical.tenant_id
       AND canonical_definition.archived_at IS NULL
      JOIN crm.contacts contact
        ON contact.id = conversation.contact_id
       AND contact.tenant_id = conversation.tenant_id
      JOIN automation.handoffs handoff
        ON handoff.id=${payload.handoffId}::uuid
       AND handoff.tenant_id=conversation.tenant_id
       AND handoff.contact_id=contact.id
       AND handoff.conversation_id=conversation.id
       AND handoff.source_channel='whatsapp'
       AND handoff.status IN ('pending','accepted')
      JOIN crm.contact_channel_identities identity
        ON identity.id=authorized_job.callback_sender_identity_id
       AND identity.tenant_id=conversation.tenant_id
       AND identity.contact_id=contact.id
       AND identity.channel='whatsapp'
       AND identity.validation_status='valid'
      JOIN messaging.inbound_message_origins origin
        ON origin.tenant_id=conversation.tenant_id
       AND origin.message_id=authorized_job.callback_trigger_message_id
       AND origin.contact_identity_id=authorized_job.callback_sender_identity_id
       AND origin.sender_address=authorized_job.callback_destination
       AND identity.normalized_value=origin.sender_address
      JOIN messaging.messages trigger
        ON trigger.id = origin.message_id
       AND trigger.tenant_id = origin.tenant_id
       AND trigger.conversation_id = conversation.id
       AND trigger.direction = 'inbound'
       AND trigger.content_type = 'text'
       AND trigger.provider = 'meta'
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
      !/^\+[1-9][0-9]{7,14}$/u.test(row.sender_address) ||
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
    return {
      actorRole: "agent",
      actorUserId: payload.actorUserId,
      agentVersionId: row.agent_version_id,
      contactId: payload.contactId,
      conversationId: payload.conversationId,
      destination: row.sender_address,
      flowId: payload.flowId,
      flowVersion: payload.flowVersion,
      handoffId: payload.handoffId,
      idempotencyKey: `whatsapp-auto-call:${payload.triggerMessageId}`,
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
    if (!(await openingMenuBusinessJobAllowed(sql, workerId, job)))
      throw new TypeError("opening_menu_route_denied");
    // The dispatcher/provider request is deliberately outside any DB transaction.
    const result = await automation.automaticCallProvider.place(work);
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job);
      // Bind the canonical session to the issue's attempt. The unique index on
      // (tenant, session) is what stops a replayed acceptance attaching one
      // call to two attempts, and binding here is also the backstop for a call
      // that reached a terminal status before this transaction ran.
      const attempt = await transaction<{ id: string; ticket_id: string }[]>`
        SELECT id, ticket_id FROM support.ticket_call_attempts
        WHERE tenant_id = platform.current_tenant_id() AND job_id = ${job.id}::uuid
        LIMIT 1
      `;
      const attemptRow = attempt[0];
      if (attemptRow !== undefined) {
        await bindTicketCallAttemptSession(
          transaction,
          attemptRow.id,
          result.sessionId,
        );
        await recordTicketEvent(transaction, work.actorUserId, {
          ticketId: attemptRow.ticket_id,
          kind: "call_outcome",
          actorKind: "system",
          summarySafe: "The telephone call was accepted by the dispatcher.",
          evidence: { sessionId: result.sessionId, attemptId: attemptRow.id },
        });
      }
      // A voice session is linked only when the trusted source conversation
      // resolves to one active service case. Ambiguous conversations remain
      // unlinked for an authorized operator to resolve; phone-number matching
      // is deliberately never used here.
      const linkedCase = await transaction<{ case_id: string }[]>`
        WITH candidates AS (
          SELECT link.case_id
          FROM service.case_conversations link
          JOIN service.cases service_case
            ON service_case.id=link.case_id
           AND service_case.tenant_id=link.tenant_id
          JOIN platform.tenant_feature_entitlements entitlement
            ON entitlement.tenant_id=link.tenant_id
           AND entitlement.feature_key='field_service'
           AND entitlement.available
          JOIN service.tenant_configuration configuration
            ON configuration.tenant_id=link.tenant_id
           AND configuration.enabled
          WHERE link.conversation_id=${work.conversationId}::uuid
            AND service_case.status NOT IN ('closed', 'cancelled')
        ), unambiguous AS (
          SELECT min(case_id::text)::uuid AS case_id
          FROM candidates
          HAVING count(*)=1
        )
        INSERT INTO service.case_calls(
          tenant_id, case_id, session_id, relationship, linked_by_user_id
        )
        SELECT platform.current_tenant_id(), unambiguous.case_id,
               ${result.sessionId}::uuid, 'diagnostic',
               ${work.actorUserId}::uuid
        FROM unambiguous
        ON CONFLICT (tenant_id, case_id, session_id) DO NOTHING
        RETURNING case_id
      `;
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
                  caseId: linkedCase[0]?.case_id,
                })})
      `;
      if (linkedCase[0] !== undefined)
        await transaction`
          INSERT INTO audit.records(
            tenant_id, actor_user_id, action, target_type, target_id, metadata
          ) VALUES (
            platform.current_tenant_id(), ${work.actorUserId}::uuid,
            'field_service.call.linked', 'service_case',
            ${linkedCase[0].case_id}::uuid,
            ${transaction.json({
              conversationId: work.conversationId,
              sessionId: result.sessionId,
              relationship: "diagnostic",
              automatic: true,
            })}
          )
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
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent)
        await transaction`
          UPDATE ops.jobs SET max_attempts=attempts
          WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
        `;
      const failClaim = async () => {
        await transaction`
          SELECT ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${reason}, 10)
        `;
      };
      const dead = await transaction<{ dead: boolean }[]>`
        SELECT attempts>=max_attempts AS dead FROM ops.jobs WHERE id=${job.id}::uuid
      `;
      if (dead[0]?.dead === true && payload !== undefined) {
        const stillOwned = await transaction<{ id: string }[]>`
          SELECT id FROM messaging.conversations WHERE id=${payload.conversationId}::uuid
            AND ownership_mode='ai' AND ai_enabled_by_user_id=${payload.actorUserId}::uuid
            AND ownership_epoch=${payload.ownershipEpoch}::bigint FOR UPDATE
        `;
        // A failed old generation must not overwrite a later takeover/resume.
        if (stillOwned[0] === undefined) {
          await failClaim();
          return;
        }
        const fallbackReason = "Automatic telephone call could not be started";
        const handoff = await transaction<{ id: string }[]>`
          UPDATE automation.handoffs
          SET status='pending', reason_safe=${fallbackReason},
              assigned_user_id=NULL, accepted_at=NULL,
              updated_at=CURRENT_TIMESTAMP
          WHERE id=${payload.handoffId}::uuid
            AND contact_id=${payload.contactId}::uuid
            AND conversation_id=${payload.conversationId}::uuid
            AND source_channel='whatsapp'
          RETURNING id
        `;
        const callFailureDescription = [
          `Escalation reason: ${fallbackReason}`,
          `Safe error code: ${reason}`,
          "Review the linked conversation and contact timeline before following up.",
        ]
          .join("\n")
          .slice(0, 20_000);
        if (handoff[0] !== undefined) {
          const ticket = await transaction<{ id: string }[]>`
            INSERT INTO crm.tasks
              (tenant_id, contact_id, created_by_user_id, title, description, status, priority)
            SELECT platform.current_tenant_id(), ${payload.contactId}::uuid,
                   ${payload.actorUserId}::uuid,
                   'AI callback requires attention', ${callFailureDescription},
                   'todo', 'urgent'
            WHERE NOT EXISTS (
              SELECT 1 FROM audit.records
              WHERE action='conversation.ai_handoff_ticket'
                AND target_type='handoff' AND target_id=${handoff[0].id}::uuid
            )
            RETURNING id
          `;
          if (ticket[0] !== undefined) {
            const authoredNote = await transaction<{ id: string }[]>`
              INSERT INTO crm.notes (tenant_id, contact_id, author_user_id, body)
              VALUES (platform.current_tenant_id(), ${payload.contactId}::uuid,
                      ${payload.actorUserId}::uuid, ${callFailureDescription})
              RETURNING id
            `;
            await transaction`
              INSERT INTO messaging.notifications
                (tenant_id, user_id, type, title, body, reference_type, reference_id)
              SELECT platform.current_tenant_id(), recipient.user_id,
                     'handoff.requested', 'AI call needs human attention',
                     'The requested AI call could not start. Review the ticket and contact history.',
                     'handoff', ${handoff[0].id}::uuid
              FROM platform.current_tenant_notification_recipients() recipient
            `;
            await transaction`
              INSERT INTO audit.records
                (tenant_id, actor_user_id, action, target_type, target_id, metadata)
              VALUES (platform.current_tenant_id(), ${payload.actorUserId}::uuid,
                      'conversation.ai_handoff_ticket', 'handoff',
                      ${handoff[0].id}::uuid,
                      ${transaction.json({ taskId: ticket[0].id, noteId: authoredNote[0]?.id, callJobId: job.id, sourceJobId: job.id, sourceClaimToken: job.claim_token })})
            `;
          }
        }
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
      // Stamp server-authored fallback receipts while the original claim is
      // fresh, then atomically transition the job to retry/dead in this txn.
      await failClaim();
    });
  }
}

async function requireOwnedJob(
  transaction: postgres.TransactionSql,
  workerId: string,
  job: JobRow,
): Promise<Date> {
  if (job.claimLost)
    throw new WhatsAppProviderError("stale_worker_claim", false);
  const owned = await transaction<{ id: string; lease_expires_at: Date }[]>`
    SELECT id, lease_expires_at FROM ops.jobs WHERE id=${job.id}::uuid AND status='running'
      AND tenant_id=platform.current_tenant_id() AND locked_by=${workerId}
      AND claim_token=${job.claim_token}::uuid AND lease_expires_at>clock_timestamp()
    FOR UPDATE
  `;
  const current = owned[0];
  if (owned.length !== 1 || current === undefined) {
    job.claimLost = true;
    throw new WhatsAppProviderError("stale_worker_claim", false);
  }
  return current.lease_expires_at;
}

async function withOwnedJobTransaction<T>(
  sql: Sql,
  workerId: string,
  job: JobRow,
  operation: (transaction: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    const leaseDeadline = await requireOwnedJob(transaction, workerId, job);
    const value = await operation(transaction);
    // The locked job cannot be reclaimed or renewed while this transaction
    // runs. Validate its captured deadline again before business writes commit,
    // including paths that already cleared the lease on completion/failure.
    const valid = await transaction<{ valid: boolean }[]>`
      SELECT ${leaseDeadline.toISOString()}::timestamptz > clock_timestamp() AS valid
    `;
    if (job.claimLost || valid[0]?.valid !== true) {
      job.claimLost = true;
      throw new WhatsAppProviderError("stale_worker_claim", false);
    }
    return value;
  });
  return result as T;
}

async function withRenewedJobLease(
  sql: Sql,
  workerId: string,
  job: JobRow,
  operation: () => Promise<void>,
): Promise<void> {
  const stop = new AbortController();
  const renewal = (async () => {
    while (!stop.signal.aborted) {
      try {
        await leaseDelay(15000, undefined, { signal: stop.signal });
      } catch {
        return;
      }
      try {
        const renewed = await sql.begin(async (transaction) => {
          await setTenantContext(transaction, job.tenant_id);
          return transaction<
            { renewed: boolean }[]
          >`SELECT ops.renew_messaging_job_claim(${job.id}::uuid,${workerId},${job.claim_token}::uuid) renewed`;
        });
        if (renewed[0]?.renewed !== true) {
          job.claimLost = true;
          return;
        }
      } catch {
        job.claimLost = true;
        return;
      }
    }
  })();
  try {
    await operation();
  } catch (error) {
    if (!job.claimLost) throw error;
  } finally {
    stop.abort();
    await renewal;
  }
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

/**
 * Re-prove at delivery that the lead write the reply relies on exists, belongs
 * to this conversation and is at least the revision that was committed. A lead
 * deleted, moved or rolled back between generation and delivery withdraws the
 * permission to claim the save; a later revision does not, because the claim
 * was true when it was made and remains true now.
 */
async function committedRecordStillHolds(
  transaction: postgres.TransactionSql,
  conversationId: string,
  claimed: unknown,
): Promise<boolean> {
  const value = record(claimed);
  if (!uuid(value.leadId) || typeof value.revision !== "number") return false;
  const rows = await transaction<{ id: string }[]>`
    SELECT id FROM crm.leads
    WHERE id=${value.leadId}::uuid
      AND source_conversation_id=${conversationId}::uuid
      AND revision >= ${value.revision}
  `;
  return rows[0] !== undefined;
}

async function requireGroundedOutbound(
  transaction: postgres.TransactionSql,
  row: {
    readonly provider_payload: unknown;
    readonly content_text: string | null;
    readonly conversation_id: string;
    readonly message_id: string;
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
  const recentAssistantMessages = await recentDeliveredReplies(
    transaction,
    row.conversation_id,
    row.message_id,
  );
  const triggerMessages = await transaction<
    { content_text: string | null; content_type: string }[]
  >`
    SELECT content_text,content_type FROM messaging.messages
    WHERE id=${metadata.triggerMessageId}::uuid
      AND conversation_id=${row.conversation_id}::uuid
      AND direction='inbound'
  `;
  const latestCustomerMessage = messageContextText(
    triggerMessages[0]?.content_type ?? "text",
    triggerMessages[0]?.content_text ?? null,
  );
  let expected: string | undefined;
  if (evidence.kind === "unsupported_media") {
    if (
      (await remediationEnabled(transaction, "no_silence")) &&
      (await storedUnsupportedMedia(
        transaction,
        row.conversation_id,
        metadata.triggerMessageId,
      ))
    )
      expected = unsupportedMediaReply(metadata.locale);
  } else if (
    evidence.kind === "failure_fallback" &&
    uuid(evidence.taskId) &&
    uuid(evidence.sourceJobId)
  ) {
    const receipt = await transaction<{ id: string }[]>`
      SELECT task.id FROM crm.tasks task
      JOIN audit.records a ON a.tenant_id=task.tenant_id
        AND a.action='conversation.ai_model_failure' AND a.target_type='job'
        AND a.target_id=${evidence.sourceJobId}::uuid AND a.metadata->>'taskId'=task.id::text
        AND a.metadata->>'conversationId'=${row.conversation_id}
        AND a.metadata->>'triggerMessageId'=${metadata.triggerMessageId}
      WHERE task.id=${evidence.taskId}::uuid AND task.status IN ('todo','in_progress')
    `;
    if (receipt.length === 1) expected = modelFailureReply(metadata.locale);
  } else if (
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
    const code = conversationReplyCodes.find((item) => item === evidence.code);
    if (code !== undefined)
      expected = groundAiReply(
        { action: "reply", text: "", replyCode: code },
        [],
        metadata.locale,
        recentAssistantMessages,
        latestCustomerMessage,
      ).text;
    else if (
      evidence.code === "generated" &&
      safeConversationalReply(row.content_text ?? "", {
        locale: metadata.locale,
        recentAssistantMessages,
        latestCustomerMessage,
        committedRecord: await committedRecordStillHolds(
          transaction,
          row.conversation_id,
          evidence.record,
        ),
      })
    )
      expected = row.content_text ?? "";
  } else if (evidence.kind === "scope_policy") {
    // Re-derive the route from the stored trigger and the approved wording
    // from the tenant's current identity: neither is taken from the payload.
    const identities = await transaction<
      { profile: TenantIdentityProjection | null }[]
    >`SELECT platform.current_voice_tenant_support_profile() AS profile`;
    const route = classifyCustomerTurn(latestCustomerMessage).route;
    const name = tenantDisplayNameFrom(identities[0]?.profile ?? null);
    if (
      route !== null &&
      route === evidence.route &&
      approvedAgentResponses(name).has(row.content_text ?? "")
    )
      expected = approvedAgentResponse(route, metadata.locale, name);
  } else if (evidence.kind === "receipt" && uuid(evidence.resourceId)) {
    if (evidence.operation === "ticket") {
      const receipt = await transaction<
        { allowed: boolean }[]
      >`SELECT platform.machine_ticket_delivery_receipt(${row.message_id}::uuid,${evidence.resourceId}::uuid) AS allowed`;
      if (receipt[0]?.allowed === true)
        expected = actionReceiptReply("ticket", metadata.locale);
    } else if (evidence.operation === "handoff") {
      const receipt = await transaction<{ id: string }[]>`
        SELECT id FROM automation.handoffs WHERE id=${evidence.resourceId}::uuid
          AND conversation_id=${row.conversation_id}::uuid
          AND requested_by_user_id=${row.requested_by_user_id}::uuid AND status='pending'
      `;
      if (receipt[0] !== undefined)
        expected = actionReceiptReply("handoff", metadata.locale);
    } else if (evidence.operation === "callback") {
      const receipt = await transaction<{ id: string }[]>`
        SELECT job.id FROM ops.jobs job
        JOIN messaging.inbound_message_origins origin
          ON origin.tenant_id=job.tenant_id
         AND origin.message_id=job.callback_trigger_message_id
         AND origin.contact_identity_id=job.callback_sender_identity_id
         AND origin.sender_address=job.callback_destination
        JOIN crm.contact_channel_identities identity
          ON identity.tenant_id=origin.tenant_id
         AND identity.id=origin.contact_identity_id
         AND identity.normalized_value=origin.sender_address
         AND identity.validation_status='valid'
        WHERE job.id=${evidence.resourceId}::uuid
          AND job.reference_id=${row.conversation_id}::uuid
          AND job.job_type='whatsapp.ai.call'
          AND job.callback_trigger_message_id=${metadata.triggerMessageId}::uuid
          AND job.payload->>'actorUserId'=${row.requested_by_user_id}
          AND job.status IN ('queued','running','retry','succeeded')
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
  await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job);
    await requireTenantFeatures(transaction, ["whatsapp"]);
    const authority = await transaction<{ authorized: boolean }[]>`
      SELECT platform.outbound_execution_authorized(
        ${job.id}::uuid,${workerId},${job.claim_token}::uuid)
        AND platform.opening_menu_business_job_allowed(
        ${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS authorized`;
    if (authority[0]?.authorized !== true)
      throw new WhatsAppProviderError("outbound_eligibility_changed", false);
    const rows = await transaction<
      {
        content_text: string | null;
        provider_payload: unknown;
        conversation_id: string;
        message_id: string;
        requested_by_user_id: string;
        sender_type: string;
      }[]
    >`
      SELECT message.id AS message_id, message.content_text, message.provider_payload,
             request.conversation_id,
             request.requested_by_user_id, message.sender_type
      FROM messaging.outbound_requests request
      JOIN messaging.messages message ON message.id=request.message_id
      JOIN messaging.conversations conversation ON conversation.id=request.conversation_id
      JOIN messaging.channels channel ON channel.id=request.channel_id
      JOIN crm.contact_channel_identities identity ON identity.id=request.recipient_identity_id
      JOIN crm.contacts contact ON contact.id=conversation.contact_id
      WHERE request.id=${work.requestId}::uuid AND request.status='sending'
        AND (request.message_kind<>'template' OR platform.whatsapp_templates_enabled())
        AND request.message_id=${work.messageId}::uuid
        AND channel.status='active' AND channel.provider=request.provider
        AND request.provider=${work.provider}
        AND request.recipient_address=${work.recipient}
        AND identity.normalized_value=request.recipient_address
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
  return withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job);
    await requireTenantFeatures(transaction, ["whatsapp"]);
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
        recipient_address: string;
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
        AND request.recipient_address = identity.normalized_value
        AND request.status = 'queued'
        AND (request.message_kind<>'template' OR platform.whatsapp_templates_enabled())
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
                request.recipient_address, channel.provider_account_id AS sender_phone_number_id
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
      recipient: row.recipient_address,
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
  resolveChannelCredential: MessagingAutomationOptions["resolveChannelCredential"],
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
      ...(providerName !== "meta"
        ? {}
        : {
            accessTokenForAttempt: async () => {
              await revalidateOutboundAttempt(sql, workerId, job, outboundWork);
              return withOwnedJobTransaction(
                sql,
                workerId,
                job,
                async (transaction) => {
                  await setTenantContext(transaction, job.tenant_id);
                  await requireOwnedJob(transaction, workerId, job);
                  const projected = await transaction<
                    {
                      envelope:
                        ChannelCredentialEnvelope | { legacy: true } | null;
                    }[]
                  >`
              SELECT platform.messaging_outbound_channel_credential(${job.id}::uuid,${workerId},${job.claim_token}::uuid) AS envelope`;
                  const envelope = projected[0]?.envelope;
                  if (envelope === undefined || envelope === null)
                    throw new WhatsAppProviderError(
                      "channel_credential_unavailable",
                      false,
                    );
                  if ("legacy" in envelope) return undefined;
                  if (resolveChannelCredential === undefined)
                    throw new WhatsAppProviderError(
                      "channel_credential_unavailable",
                      false,
                    );
                  try {
                    return resolveChannelCredential(envelope);
                  } catch {
                    throw new WhatsAppProviderError(
                      "channel_credential_unavailable",
                      false,
                    );
                  }
                },
              );
            },
          }),
      ...(outboundWork.senderPhoneNumberId === undefined
        ? {}
        : { senderPhoneNumberId: outboundWork.senderPhoneNumberId }),
    });
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
      await setTenantContext(transaction, outboundWork.tenantId);
      await requireOwnedJob(transaction, workerId, job);
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
    const providerDelay =
      error instanceof WhatsAppProviderError && error.status === 429
        ? error.retryAfterMs
        : undefined;
    const invalidDelay =
      providerDelay !== undefined &&
      (!Number.isFinite(providerDelay) ||
        providerDelay <= 0 ||
        providerDelay > 86_400_000);
    const retryable =
      error instanceof WhatsAppProviderError &&
      error.retryable &&
      !invalidDelay;
    if (
      error instanceof WhatsAppProviderError &&
      error.code === "stale_worker_claim"
    )
      return;
    const failure = messageDeliveryFailure(
      error instanceof TenantFeatureRuntimeError
        ? error.code
        : error instanceof WhatsAppProviderError
          ? error.code
          : work?.provider === "meta"
            ? "delivery_outcome_unknown"
            : "outbound_processing_failed",
      error instanceof WhatsAppProviderError ? error.diagnostic : null,
    ) ?? { code: "outbound_processing_failed", diagnostic: null };
    const code = invalidDelay ? "rate_limit_delay_quarantined" : failure.code;
    await withOwnedJobTransaction(sql, workerId, job, async (transaction) => {
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
        SELECT ops.fail_messaging_job_claim(${job.id}::uuid, ${workerId}, ${job.claim_token}::uuid, ${code}, 5)
      `;
      if (retryable && providerDelay !== undefined)
        await transaction`
          UPDATE ops.jobs SET available_at=GREATEST(available_at,
            clock_timestamp()+${providerDelay}::double precision * interval '1 millisecond')
          WHERE id=${job.id}::uuid AND tenant_id=platform.current_tenant_id()
            AND status='retry' AND last_error_safe=${code}
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
  const activeReplies = new Map<string, Promise<void>>();
  const activeSummaries = new Map<string, Promise<void>>();
  const replyFailures: unknown[] = [];
  let closing = false;
  const drainReplies = async () => {
    await Promise.all([...activeReplies.values(), ...activeSummaries.values()]);
    if (replyFailures.length) throw replyFailures.shift();
  };
  const pendingAccounting = new Map<
    string,
    {
      context: { tenantId: string; jobId: string; agentVersionId: string };
      attempt: WhatsAppAiAttempt;
    }
  >();
  const persistAttempt = async (
    context: { tenantId: string; jobId: string; agentVersionId: string },
    attempt: WhatsAppAiAttempt,
  ) => {
    await automation.modelAccountingSpool?.put({ ...attempt, ...context });
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, context.tenantId);
      await transaction`
        SELECT agents.record_messaging_model_attempt(${attempt.eventId}::uuid,
          ${context.jobId}::uuid,${context.agentVersionId}::uuid,${attempt.model},
          ${attempt.occurredAt}::timestamptz,${attempt.latencyMs},${attempt.inputTokens},
          ${attempt.outputTokens},${attempt.status},${attempt.errorCode})
      `;
    });
    await automation.modelAccountingSpool?.acknowledgeCommitted({
      ...attempt,
      ...context,
    });
    pendingAccounting.delete(attempt.eventId);
    automation.aiProvider?.acknowledgeAttempt?.(attempt);
  };
  const runtimeAutomation: MessagingAutomationOptions = {
    ...automation,
    beforeModelAttempt: async () => {
      await automation.modelAccountingSpool?.assertCapacity();
      if (
        automation.modelAccountingSpool !== undefined &&
        (await automation.modelAccountingSpool.pending()).length > 998
      )
        throw new Error("accounting spool lacks capacity for bounded fallback");
      await automation.beforeModelAttempt?.();
    },
    modelAttemptRecorder: async (context, attempt) => {
      // Immutable provider event+server admission are the ONLY permitted
      // post-loss write. This never enters a business transaction or sends.
      pendingAccounting.set(attempt.eventId, { context, attempt });
      await automation.modelAccountingSpool?.put({ ...attempt, ...context });
      await persistAttempt(context, attempt);
    },
  };
  return {
    drainReplies,
    async close() {
      closing = true;
      try {
        await drainReplies();
      } finally {
        await sql.end({ timeout: 2 });
      }
    },
    async isReady() {
      try {
        const rows = await sql<{ ready: boolean }[]>`
          SELECT coalesce(bool_and(function.oid IS NOT NULL AND
            has_function_privilege(current_user,function.oid,'EXECUTE')),false) AS ready
          FROM unnest(ARRAY[
            'ops.claim_inbound_events(text,integer,integer,boolean)',
            'ops.claim_fair_ai_reply(text)',
            'ops.claim_jobs_all_tenants(text,text,integer,integer)',
            'ops.renew_messaging_job_claim(uuid,text,uuid)',
            'platform.current_field_service_whatsapp_agent_ready()',
            'platform.current_published_model_route(uuid,uuid,uuid)',
            'platform.admit_messaging_session_agent(uuid,text,uuid,integer)',
            'platform.load_memory_summary_job(uuid,text,uuid)',
 'ops.claim_memory_summary(text)',
 'platform.memory_summary_model_projection(uuid,text,uuid)',
 'platform.reserve_memory_summary_attempt(uuid,text,uuid,jsonb)',
 'platform.settle_memory_summary_attempt(uuid,text,uuid,uuid,boolean,integer,integer)',
            'platform.persist_memory_summary_job(uuid,text,uuid,text)',
            'platform.admit_messaging_execution_principal(uuid,text,uuid)',
            'platform.capture_principal_handoff_authority(uuid,text,uuid,uuid)',
            'platform.messaging_media_channel_credential(uuid,text,uuid,bigint)',
            'platform.messaging_typing_channel_credential(uuid,bigint)',
            'platform.prepare_opening_menu(uuid,text,uuid)',
            'platform.begin_opening_menu_attempt(uuid,text,uuid)',
            'platform.opening_menu_attempt_authorized(uuid,text,uuid)',
            'platform.opening_menu_channel_credential(uuid,text,uuid)',
            'platform.settle_opening_menu_attempt(uuid,text,uuid,text,text)',
            'platform.opening_menu_business_job_allowed(uuid,text,uuid)',
            'platform.enqueue_opening_menu_for_inbound(uuid)',
            'platform.messaging_model_credential(uuid,text,uuid,uuid,uuid,uuid,uuid,bigint,uuid)',
            'agents.reserve_messaging_model_attempt(uuid,text,uuid,uuid,uuid,uuid,bigint,uuid,jsonb)'
          ]) AS required(signature)
          LEFT JOIN pg_proc function ON function.oid=to_regprocedure(required.signature)
        `;
        return rows[0]?.ready === true;
      } catch {
        return false;
      }
    },
    async processAvailable() {
      if (closing) return 0;
      if (replyFailures.length) throw replyFailures.shift();
      if (automation.modelAccountingSpool !== undefined) {
        for (const attempt of await automation.modelAccountingSpool.pending()) {
          const { tenantId, jobId, agentVersionId } = attempt;
          pendingAccounting.set(attempt.eventId, {
            context: { tenantId, jobId, agentVersionId },
            attempt,
          });
        }
      }
      for (const entry of [...pendingAccounting.values()].slice(0, 16)) {
        try {
          await persistAttempt(entry.context, entry.attempt);
        } catch {
          break;
        }
      }
      // Keep accepted inbound events durable while accounting is unavailable;
      // do not accumulate an unbounded number of newly billed calls.
      const accountingBlocked = pendingAccounting.size >= 1000;
      let processedEvents = 0;
      // Ingest a bounded pending burst before spending on the agent. Claims
      // remain one at a time and processing remains sequential, so ingress
      // leases cannot age while earlier envelopes wait on a provider call.
      for (let pass = 0; pass < 10; pass += 1) {
        const events = await sql<InboundEventRow[]>`
        SELECT id, tenant_id, event_type, payload
        FROM ops.claim_inbound_events(${workerId}, 1, 60, true)
      `;
        if (events.length === 0) break;
        for (const event of events)
          await processInbound(
            sql,
            workerId,
            event,
            automation.aiProvider !== undefined,
            automation.realWhatsAppEnabled === true,
            automation.fieldServiceProvider !== undefined,
            providers.meta,
            automation.resolveChannelCredential,
          );
        processedEvents += events.length;
      }

      if (accountingBlocked) return processedEvents;
      // Durable admission counts live claims across workers. Launch immediately:
      // no claimed job waits in an in-process queue or ages its lease there.
      // Provider I/O holds no DB transaction; ingress and sends keep polling.
      let admittedReplies = 0;
      while (activeReplies.size < 4) {
        const replies = await sql<JobRow[]>`
          SELECT id,tenant_id,job_type,reference_id,payload,claim_token
          FROM ops.claim_fair_ai_reply(${workerId})
        `;
        const reply = replies[0];
        if (reply === undefined) break;
        const running = withRenewedJobLease(sql, workerId, reply, () =>
          processJob(
            sql,
            workerId,
            reply,
            providers,
            reportFailure,
            runtimeAutomation,
          ),
        )
          .catch((error: unknown) => {
            // Keep the rejected promise observed. The next poll/drain surfaces an
            // unexpected failure; fresh fences still protect every write/send.
            replyFailures.push(error);
          })
          .finally(() => activeReplies.delete(reply.id));
        activeReplies.set(reply.id, running);
        admittedReplies += 1;
      }
      let admittedSummaries = 0;
      if (activeSummaries.size < 1) {
        const summaries = await sql<
          JobRow[]
        >`SELECT id,tenant_id,job_type,reference_id,payload,claim_token FROM ops.claim_memory_summary(${workerId})`;
        const summary = summaries[0];
        if (summary !== undefined) {
          const running = withRenewedJobLease(sql, workerId, summary, () =>
            processJob(
              sql,
              workerId,
              summary,
              providers,
              reportFailure,
              runtimeAutomation,
            ),
          )
            .catch((error: unknown) => {
              replyFailures.push(error);
            })
            .finally(() => activeSummaries.delete(summary.id));
          activeSummaries.set(summary.id, running);
          admittedSummaries = 1;
        }
      }
      const jobs = await sql<JobRow[]>`
        SELECT id, tenant_id, job_type, reference_id, payload, claim_token
        FROM ops.claim_jobs_all_tenants(${workerId}, 'messaging', 1, 120)
      `;
      for (const job of jobs)
        await withRenewedJobLease(sql, workerId, job, () =>
          processJob(
            sql,
            workerId,
            job,
            providers,
            reportFailure,
            runtimeAutomation,
          ),
        );
      const fieldServiceJobs = await sql<JobRow[]>`
        SELECT id, tenant_id, job_type, reference_id, payload, claim_token
        FROM ops.claim_jobs_all_tenants(${workerId}, 'field_service', 1, 120)
      `;
      for (const job of fieldServiceJobs)
        await withRenewedJobLease(sql, workerId, job, () =>
          processJob(
            sql,
            workerId,
            job,
            providers,
            reportFailure,
            runtimeAutomation,
          ),
        );
      let completedRepliesDuringWait = 0;
      if (
        (activeReplies.size > 0 || activeSummaries.size > 0) &&
        admittedReplies === 0 &&
        admittedSummaries === 0 &&
        jobs.length === 0 &&
        fieldServiceJobs.length === 0 &&
        processedEvents === 0
      ) {
        const repliesBeforeWait = activeReplies.size + activeSummaries.size;
        await Promise.race([
          ...activeReplies.values(),
          ...activeSummaries.values(),
          leaseDelay(50),
        ]);
        // A reply may commit its outbound after this poll's queue snapshot.
        // Report that progress so the worker immediately scans again rather
        // than sleeping for a second with a newly queued customer answer.
        completedRepliesDuringWait =
          repliesBeforeWait - activeReplies.size - activeSummaries.size;
      }
      return (
        processedEvents +
        jobs.length +
        fieldServiceJobs.length +
        admittedReplies +
        admittedSummaries +
        activeSummaries.size +
        activeReplies.size +
        completedRepliesDuringWait
      );
    },
  };
}
