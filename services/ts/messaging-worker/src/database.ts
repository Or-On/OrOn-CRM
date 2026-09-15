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
  captureWhatsAppServiceIntakeMessage,
  confirmWhatsAppServiceIntake,
  findOpenWhatsAppServiceIntake,
  getFieldServiceFeatureState,
  handoffWhatsAppServiceIntake,
  missingIntakeFields,
  commitPrivateObject,
  discardPrivateObject,
  protectNationalIdWithKeys,
  readPrivateObject,
  sanitizeIntakeProposal,
  stagePrivateObject,
  updateWhatsAppServiceIntake,
  type ProtectedFieldKeys,
  type PrivateObjectStorageOptions,
  type StagedPrivateObject,
  type MessageDeliveryFailure,
} from "@or-on/crm";

import type { WhatsAppProvider, WhatsAppSendRequest } from "./providers.js";
import { WhatsAppProviderError } from "./providers.js";
import {
  WhatsAppAiProviderError,
  type WhatsAppAiDecision,
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
  enforceStandaloneCallbackConsent,
  explicitlyRequestsImmediateCall,
  factDigest,
  groundAiReply,
  latestMessageLocale,
  safeConversationalReply,
  type EligibleKnowledgeFact,
  type GroundedReply,
} from "./ai-grounding.js";
import {
  FieldServiceAiProviderError,
  type FieldServiceAiProvider,
} from "./field-service-provider.js";

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
  readonly fieldServiceProvider?: FieldServiceAiProvider;
  readonly protectedFieldKeys?: ProtectedFieldKeys;
  readonly privateObjectStorage?: PrivateObjectStorageOptions;
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
  fieldServiceAiAvailable: boolean,
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
        if (result.inserted && result.messageId !== undefined) {
          await createInboundConversationNotifications(
            transaction,
            result.conversationId,
          );
          if (aiEnabled && realWhatsAppEnabled)
            await assignDefaultWhatsAppAi(transaction, result.conversationId);
          if (envelope.media !== undefined)
            await transaction`
              INSERT INTO ops.jobs
                (tenant_id, queue, job_type, reference_type, reference_id, payload,
                 idempotency_key, max_attempts, priority)
              SELECT platform.current_tenant_id(), 'messaging',
                     'field_service.whatsapp_media.retrieve', 'message',
                     ${result.messageId}::uuid,
                     ${transaction.json({
                       conversationId: result.conversationId,
                       messageId: result.messageId,
                       mediaId: envelope.media.id,
                       contentType: envelope.contentType,
                       expectedMimeType: envelope.media.mimeType,
                       expectedSha256: envelope.media.sha256,
                     })},
                     ${`field-service:media:${result.messageId}`}, 4, 30
              FROM platform.tenant_feature_entitlements entitlement
              JOIN service.tenant_configuration configuration
                ON configuration.tenant_id=entitlement.tenant_id
              WHERE entitlement.tenant_id=platform.current_tenant_id()
                AND entitlement.feature_key='field_service'
                AND entitlement.available AND configuration.enabled
                AND configuration.whatsapp_intake_enabled
                AND ${realWhatsAppEnabled}
              ON CONFLICT DO NOTHING
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
                   ${`field-service:intake:${result.messageId}`}, 4, 20
            FROM platform.tenant_feature_entitlements entitlement
            JOIN service.tenant_configuration configuration
              ON configuration.tenant_id=entitlement.tenant_id
            WHERE entitlement.tenant_id=platform.current_tenant_id()
              AND entitlement.feature_key='field_service'
              AND entitlement.available AND configuration.enabled
              AND configuration.whatsapp_intake_enabled
              AND ${fieldServiceAiAvailable}
            ON CONFLICT DO NOTHING
          `;
          await transaction`
            INSERT INTO ops.jobs
              (tenant_id, queue, job_type, reference_type, reference_id, payload,
               idempotency_key, max_attempts)
            SELECT platform.current_tenant_id(), 'messaging', 'whatsapp.ai.reply',
                   'conversation', ${result.conversationId}::uuid,
                   jsonb_build_object('conversationId', ${result.conversationId}::uuid,
                     'triggerMessageId', ${result.messageId}::uuid),
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

interface FieldServiceIntakeWork {
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
  jobId: string,
  workerId: string,
): Promise<void> {
  await transaction`
    UPDATE ops.jobs SET status='succeeded', completed_at=CURRENT_TIMESTAMP,
      locked_at=NULL, locked_by=NULL, last_error_safe=NULL,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=${jobId}::uuid AND status='running' AND locked_by=${workerId}
  `;
}

async function cancelJobForDisabledFeature(
  transaction: postgres.TransactionSql,
  jobId: string,
  workerId: string,
): Promise<void> {
  await transaction`
    UPDATE ops.jobs SET status='cancelled', completed_at=CURRENT_TIMESTAMP,
      locked_at=NULL, locked_by=NULL,
      last_error_safe='field_service_disabled', updated_at=CURRENT_TIMESTAMP
    WHERE id=${jobId}::uuid AND status='running' AND locked_by=${workerId}
  `;
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
  return sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job.id);
    const feature = await getFieldServiceFeatureState(transaction);
    if (!feature.effective || !feature.whatsAppIntakeEnabled) {
      await cancelJobForDisabledFeature(transaction, job.id, workerId);
      return undefined;
    }
    const context = await transaction<
      { locale: string; occurred_at: Date; contact_id: string }[]
    >`
      SELECT coalesce(settings.locale, 'en') AS locale,
             message.created_at AS occurred_at,
             conversation.contact_id
      FROM messaging.messages message
      JOIN messaging.conversations conversation
        ON conversation.id=message.conversation_id
       AND conversation.tenant_id=message.tenant_id
      LEFT JOIN crm.tenant_settings settings
        ON settings.tenant_id=message.tenant_id
      WHERE message.id=${triggerMessageId}::uuid
        AND message.conversation_id=${conversationId}::uuid
        AND conversation.contact_id=${contactId}::uuid
        AND message.direction='inbound'
    `;
    const bound = context[0];
    if (bound === undefined)
      throw new TypeError("field-service intake trigger is unavailable");
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
      conversationId,
      contactId: bound.contact_id,
      triggerMessageId,
      occurredAt: bound.occurred_at.toISOString(),
      locale: bound.locale,
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
): Promise<void> {
  try {
    const work = await loadFieldServiceIntakeWork(sql, workerId, job);
    if (work === undefined) return;
    const provider = automation.fieldServiceProvider;
    if (provider === undefined)
      throw new TypeError("field_service_ai_unavailable");
    const extraction = await provider.extractIntake({
      locale: work.locale,
      existingFields: work.existing?.fields ?? {},
      intakeAlreadyOpen: work.existing !== undefined,
      messages: work.messages,
    });
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job.id);
      const feature = await getFieldServiceFeatureState(transaction);
      if (!feature.effective || !feature.whatsAppIntakeEnabled) {
        await cancelJobForDisabledFeature(transaction, job.id, workerId);
        return;
      }
      const current = await findOpenWhatsAppServiceIntake(
        transaction,
        work.conversationId,
      );
      if (!extraction.serviceIntent && current === undefined) {
        await finishJob(transaction, job.id, workerId);
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
      await transaction`
        INSERT INTO audit.records(
          tenant_id, action, target_type, target_id, metadata
        ) VALUES (
          platform.current_tenant_id(), 'field_service.intake.extracted',
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
      await finishJob(transaction, job.id, workerId);
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
    });
  }
}

interface FieldServiceWhatsAppMediaWork {
  readonly conversationId: string;
  readonly messageId: string;
  readonly mediaId: string;
  readonly contentType: "image" | "document";
  readonly expectedMimeType?: string;
  readonly expectedSha256?: string;
}

async function loadFieldServiceWhatsAppMediaWork(
  sql: Sql,
  workerId: string,
  job: JobRow,
): Promise<FieldServiceWhatsAppMediaWork | undefined> {
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
    (contentType !== "image" && contentType !== "document")
  )
    throw new TypeError("invalid field-service media job payload");
  return sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job.id);
    const feature = await getFieldServiceFeatureState(transaction);
    if (!feature.effective || !feature.whatsAppIntakeEnabled) {
      await cancelJobForDisabledFeature(transaction, job.id, workerId);
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
      }[]
    >`
      SELECT message.id, message.object_id, object.status AS object_status,
             message.structured_content->>'providerMediaId' AS provider_media_id,
             message.structured_content->>'mimeType' AS expected_mime_type,
             message.structured_content->>'sha256' AS expected_sha256
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
      FOR UPDATE OF message
    `;
    const row = rows[0];
    if (row?.provider_media_id !== mediaId)
      throw new TypeError("field-service media source is unavailable");
    if (row.object_id !== null) {
      if (row.object_status !== "available")
        throw new TypeError("field-service media object is unavailable");
      await transaction`
        UPDATE messaging.messages SET
          structured_content=jsonb_set(
            coalesce(structured_content, '{}'::jsonb) - 'retrievalError',
            '{retrievalStatus}', '"available"'::jsonb, true),
          updated_at=CURRENT_TIMESTAMP
        WHERE id=${messageId}::uuid
      `;
      await finishJob(transaction, job.id, workerId);
      return undefined;
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

async function revalidateFieldServiceMediaAttempt(
  sql: Sql,
  workerId: string,
  job: JobRow,
  work: FieldServiceWhatsAppMediaWork,
): Promise<void> {
  await sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job.id);
    const feature = await getFieldServiceFeatureState(transaction);
    if (!feature.effective || !feature.whatsAppIntakeEnabled)
      throw new WhatsAppProviderError("field_service_disabled", false);
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
        AND channel.provider='meta'
    `;
    if (rows[0] === undefined)
      throw new WhatsAppProviderError("media_eligibility_changed", false);
  });
}

async function processFieldServiceWhatsAppMedia(
  sql: Sql,
  workerId: string,
  job: JobRow,
  providers: Readonly<Record<"simulator" | "meta", WhatsAppProvider>>,
  automation: MessagingAutomationOptions,
): Promise<void> {
  let staged: StagedPrivateObject | undefined;
  let committed = false;
  try {
    const work = await loadFieldServiceWhatsAppMediaWork(sql, workerId, job);
    if (work === undefined) return;
    const metaProvider = providers.meta;
    if (metaProvider.downloadMedia === undefined)
      throw new WhatsAppProviderError("media_provider_unavailable", false);
    const media = await metaProvider.downloadMedia({
      mediaId: work.mediaId,
      ...(work.expectedMimeType === undefined
        ? {}
        : { expectedMimeType: work.expectedMimeType }),
      ...(work.expectedSha256 === undefined
        ? {}
        : { expectedSha256: work.expectedSha256 }),
      beforeAttempt: () =>
        revalidateFieldServiceMediaAttempt(sql, workerId, job, work),
    });
    staged = await stagePrivateObject(
      {
        tenantId: job.tenant_id,
        caseId: work.conversationId,
        category: "whatsapp_media",
        declaredContentType: media.contentType,
        bytes: media.bytes,
      },
      automation.privateObjectStorage,
    );
    if (staged.checksum !== media.sha256)
      throw new TypeError("field-service media checksum changed");
    await commitPrivateObject(staged);
    committed = true;
    const accepted = await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job.id);
      const feature = await getFieldServiceFeatureState(transaction);
      if (!feature.effective || !feature.whatsAppIntakeEnabled) {
        await cancelJobForDisabledFeature(transaction, job.id, workerId);
        return false;
      }
      const objects = await transaction<{ id: string }[]>`
        INSERT INTO objects.object_metadata(
          tenant_id, created_by_user_id, owner_type, owner_id, category,
          content_type, byte_size, checksum, storage_backend, storage_key, status
        ) VALUES (
          platform.current_tenant_id(), NULL, 'message', ${work.messageId}::uuid,
          ${work.contentType === "image" ? "whatsapp_customer_image" : "whatsapp_customer_document"},
          ${staged?.contentType ?? media.contentType},
          ${staged?.byteSize ?? media.bytes.byteLength},
          ${staged?.checksum ?? media.sha256}, 'local',
          ${staged?.storageKey ?? ""}, 'available'
        ) RETURNING id
      `;
      const objectId = objects[0]?.id;
      if (objectId === undefined)
        throw new Error("field-service media object creation failed");
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
          "field-service media message changed during retrieval",
        );
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
      await finishJob(transaction, job.id, workerId);
      return true;
    });
    if (!accepted) await discardPrivateObject(staged);
  } catch (error) {
    if (staged !== undefined)
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
            ? "field_service_media_persistence_failed"
            : "field_service_media_retrieval_failed";
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      const owned = await transaction<{ id: string }[]>`
        SELECT id FROM ops.jobs WHERE id=${job.id}::uuid
          AND status='running' AND locked_by=${workerId} FOR UPDATE
      `;
      if (owned[0] === undefined) return;
      if (reason === "field_service_disabled") {
        await cancelJobForDisabledFeature(transaction, job.id, workerId);
        if (job.reference_id !== null)
          await transaction`
            UPDATE messaging.messages SET
              structured_content=jsonb_set(
                coalesce(structured_content, '{}'::jsonb) - 'retrievalError',
                '{retrievalStatus}', '"cancelled"'::jsonb, true),
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
        SELECT (ops.fail_job(${job.id}::uuid, ${workerId}, ${reason}, 15)).status
      `;
      if (job.reference_id !== null) {
        const finalFailure = failed[0]?.status === "dead";
        await transaction`
          UPDATE messaging.messages SET
            structured_content=jsonb_set(
              jsonb_set(coalesce(structured_content, '{}'::jsonb),
                '{retrievalStatus}',
                ${finalFailure ? '"failed"' : '"pending"'}::jsonb, true),
              '{retrievalError}',
              ${finalFailure ? JSON.stringify(reason) : "null"}::jsonb, true),
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
  return sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job.id);
    const feature = await getFieldServiceFeatureState(transaction);
    if (!feature.effective) {
      await transaction`
        UPDATE service.case_summaries SET status='failed',
          error_safe='field_service_disabled', completed_at=CURRENT_TIMESTAMP
        WHERE id=${summaryId}::uuid AND status IN ('pending','processing')
      `;
      await cancelJobForDisabledFeature(transaction, job.id, workerId);
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
      await finishJob(transaction, job.id, workerId);
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
        await finishJob(transaction, job.id, workerId);
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
      await finishJob(transaction, job.id, workerId);
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
    const mayCallProvider = await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job.id);
      const feature = await getFieldServiceFeatureState(transaction);
      if (!feature.effective) {
        await transaction`
          UPDATE service.case_summaries SET status='failed',
            error_safe='field_service_disabled', completed_at=CURRENT_TIMESTAMP
          WHERE id=${work.summaryId}::uuid AND status='processing'
        `;
        await cancelJobForDisabledFeature(transaction, job.id, workerId);
        return false;
      }
      return true;
    });
    if (!mayCallProvider) return;
    const summary = await provider.summarizeEvidence({
      sourceKind: work.sourceKind,
      locale: work.locale,
      evidence,
    });
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job.id);
      const feature = await getFieldServiceFeatureState(transaction);
      if (!feature.effective) {
        await transaction`
          UPDATE service.case_summaries SET status='failed',
            error_safe='field_service_disabled', completed_at=CURRENT_TIMESTAMP
          WHERE id=${work.summaryId}::uuid AND status='processing'
        `;
        await cancelJobForDisabledFeature(transaction, job.id, workerId);
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
        await finishJob(transaction, job.id, workerId);
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
      await finishJob(transaction, job.id, workerId);
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
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent)
        await transaction`
          UPDATE ops.jobs SET max_attempts=attempts
          WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
        `;
      const failed = await transaction<{ status: string }[]>`
        SELECT (ops.fail_job(${job.id}::uuid, ${workerId}, ${reason}, 15)).status
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
): Promise<void> {
  if (job.reference_id !== null)
    await transaction`
      UPDATE service.ocr_results SET status='failed',
        error_safe='field_service_disabled', completed_at=CURRENT_TIMESTAMP
      WHERE id=${job.reference_id}::uuid AND status IN ('pending','processing')
    `;
  await cancelJobForDisabledFeature(transaction, job.id, workerId);
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
  return sql.begin(async (transaction) => {
    await setTenantContext(transaction, job.tenant_id);
    await requireOwnedJob(transaction, workerId, job.id);
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
      }[]
    >`
      SELECT result.attachment_id, attachment.object_id, object.content_type,
             object.byte_size, object.checksum, object.storage_backend,
             object.storage_key, object.status AS object_status,
             attachment.category
      FROM service.ocr_results result
      JOIN service.report_attachments attachment
        ON attachment.id=result.attachment_id
       AND attachment.tenant_id=result.tenant_id
      JOIN objects.object_metadata object
        ON object.id=attachment.object_id AND object.tenant_id=attachment.tenant_id
      WHERE result.id=${ocrResultId}::uuid
        AND result.attachment_id=${attachmentId}::uuid
        AND result.status IN ('pending','processing')
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
    };
  });
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
    const mayCallProvider = await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job.id);
      const feature = await getFieldServiceFeatureState(transaction);
      if (!feature.effective || !feature.ocrEnabled) {
        await cancelFieldServiceOcr(transaction, job, workerId);
        return false;
      }
      return true;
    });
    if (!mayCallProvider) return;
    const extraction = await provider.extractProductLabel({
      bytes,
      contentType: work.contentType,
    });
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job.id);
      const feature = await getFieldServiceFeatureState(transaction);
      if (!feature.effective || !feature.ocrEnabled) {
        await cancelFieldServiceOcr(transaction, job, workerId);
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
      await finishJob(transaction, job.id, workerId);
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
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      if (permanent)
        await transaction`
          UPDATE ops.jobs SET max_attempts=attempts
          WHERE id=${job.id}::uuid AND status='running' AND locked_by=${workerId}
        `;
      const failed = await transaction<{ status: string }[]>`
        SELECT (ops.fail_job(${job.id}::uuid, ${workerId}, ${reason}, 15)).status
      `;
      if (job.reference_id !== null)
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
  if (
    job.job_type === "field_service.whatsapp_media.retrieve" &&
    job.reference_id !== null
  ) {
    await processFieldServiceWhatsAppMedia(
      sql,
      workerId,
      job,
      providers,
      automation,
    );
    return;
  }
  if (
    job.job_type === "field_service.intake.extract" &&
    job.reference_id !== null
  ) {
    await processFieldServiceIntake(sql, workerId, job, automation);
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
  // Meta's event time is only precise to one second. For equal provider times,
  // updated_at preserves database ingestion order; a random UUID must never
  // decide which customer turn is current.
  const latest = await transaction<{ id: string }[]>`
    SELECT id FROM messaging.messages WHERE conversation_id=${conversationId}::uuid
      AND direction='inbound'
      ORDER BY created_at DESC, updated_at DESC, id DESC LIMIT 1
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
             agent.system_prompt, agent.locale, agent.id AS agent_version_id, conversation.ownership_epoch,
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
        sender_address: string | null;
        sender_identity_id: string | null;
      }[]
    >`
      SELECT message.id, message.direction, message.content_text,
             message.created_at, origin.contact_identity_id AS sender_identity_id,
             origin.sender_address
      FROM messaging.messages message
      LEFT JOIN messaging.inbound_message_origins origin
        ON origin.tenant_id=message.tenant_id AND origin.message_id=message.id
      WHERE message.conversation_id = ${row.conversation_id}::uuid
        AND message.content_type = 'text' AND message.content_text IS NOT NULL
      ORDER BY message.created_at DESC, message.updated_at DESC, message.id DESC LIMIT 50
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
    const triggerMessage = history.find(
      (message) => message.id === triggerMessageId,
    );
    if (triggerMessage === undefined)
      throw new TypeError("AI conversation has no inbound trigger message");
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
    const responseLocale = latestMessageLocale(
      row.locale,
      triggerMessage.content_text,
    );
    const orderedHistory = history.toReversed();
    const notes = await transaction<
      { content_text: string; created_at: Date }[]
    >`
      SELECT left(note.body, 1200) AS content_text, note.created_at
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
    const tickets = await transaction<
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
    const intakes = await transaction<
      {
        status: NonNullable<AiWork["serviceIntake"]>["status"];
        collected_fields: unknown;
        national_id_hint: string | null;
        required_field_overrides: unknown;
        case_reference: string | null;
        customer_resolution_status: NonNullable<
          AiWork["serviceIntake"]
        >["customerResolutionStatus"];
      }[]
    >`
      SELECT intake.status, intake.collected_fields, intake.national_id_hint,
             intake.customer_resolution_status,
             intake.required_field_overrides, service_case.reference AS case_reference
      FROM service.intake_drafts intake
      LEFT JOIN service.cases service_case
        ON service_case.intake_draft_id=intake.id
       AND service_case.tenant_id=intake.tenant_id
      WHERE intake.conversation_id=${row.conversation_id}::uuid
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
            fields: intakeFields,
            nationalIdMasked:
              intake.national_id_hint === null
                ? null
                : `••••${intake.national_id_hint}`,
            missingFields: missingIntakeFields(
              {
                ...intakeFields,
                ...(intake.national_id_hint === null
                  ? {}
                  : { nationalId: "provided" }),
              },
              overridden as Parameters<typeof missingIntakeFields>[1],
            ),
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
      knowledge,
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
          knownBeforeConversation,
          firstConversation,
          missingProfileFields,
        },
        notes: notes.reverse().map((note) => ({
          text: note.content_text,
          occurredAt: note.created_at.toISOString(),
        })),
        previousConversations: previousConversations.reverse().map((item) => ({
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
    await transaction`
      INSERT INTO crm.notes (tenant_id, contact_id, author_user_id, body)
      VALUES (platform.current_tenant_id(), ${work.contactId}::uuid,
              ${work.authorizedUserId}::uuid, ${description})
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
              ${transaction.json({ taskId: ticket[0].id })})
    `;
  }
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
    const work = await loadAiWork(sql, workerId, job);
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
    const classifiedDecision: WhatsAppAiDecision =
      identityConflict || intakeRequiresHuman
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
          : await (automation.aiProvider?.decide(work) ??
              Promise.reject(new TypeError("WhatsApp AI is disabled")));
    const decision = enforceStandaloneCallbackConsent(
      classifiedDecision,
      explicitCallRequested,
    );
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
      if (decision.action === "handoff" && !explicitCallRequested) {
        const resourceId = await createAiHandoff(
          transaction,
          work,
          job.id,
          decision.reasonCode,
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
  readonly contactIdentityId: string;
  readonly contactId: string;
  readonly conversationId: string;
  readonly destination: string;
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
  evidence: readonly string[] = [],
): string {
  const evidenceBlock = evidence
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 1400);
  const lines = messages.map((message) => {
    const label =
      message.direction === "inbound"
        ? "Customer report (unverified)"
        : "Prior assistant statement (unverified)";
    const text = message.content_text.replace(/\s+/gu, " ").trim();
    return `${label}: ${text}`;
  });
  const selected: string[] = [];
  let length = evidenceBlock.length;
  for (const line of lines.toReversed()) {
    if (length + line.length + 1 > 3500) break;
    selected.unshift(line);
    length += line.length + 1;
  }
  if (selected.length === 0)
    throw new TypeError("automatic call conversation context is unavailable");
  return [evidenceBlock, "Recent WhatsApp conversation:", ...selected]
    .filter(Boolean)
    .join("\n");
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
        sender_address: string;
        trigger_text: string;
        agent_version_id: string;
        contact_name: string;
        contact_company: string | null;
        lifecycle_status: string;
      }[]
    >`
      SELECT origin.sender_address, trigger.content_text AS trigger_text,
             agent.id AS agent_version_id, contact.name AS contact_name,
             contact.company AS contact_company,
             contact.lifecycle_status
      FROM messaging.conversations conversation
      JOIN messaging.channels channel
        ON channel.id=conversation.channel_id
       AND channel.tenant_id=conversation.tenant_id
       AND channel.provider='meta'
       AND channel.status='active'
      JOIN ops.jobs authorization
        ON authorization.id=${job.id}::uuid
       AND authorization.tenant_id=conversation.tenant_id
       AND authorization.queue='messaging'
       AND authorization.job_type='whatsapp.ai.call'
       AND authorization.reference_type='conversation'
       AND authorization.reference_id=conversation.id
       AND authorization.callback_trigger_message_id=${payload.triggerMessageId}::uuid
       AND authorization.callback_sender_identity_id=${payload.contactIdentityId}::uuid
       AND authorization.callback_destination=${payload.destination}
      JOIN agents.agent_profile_versions agent
        ON agent.id=${payload.agentVersionId}::uuid AND agent.tenant_id=conversation.tenant_id
        AND agent.published_at IS NOT NULL
        AND agent.validation_status='valid' AND 'voice'=ANY(agent.channel_capabilities)
      JOIN automation.flow_versions canonical
        ON canonical.id=${payload.canonicalFlowVersionId}::uuid AND canonical.tenant_id=conversation.tenant_id
        AND canonical.agent_profile_version_id=conversation.ai_agent_profile_version_id
        AND canonical.published_at IS NOT NULL
        AND canonical.validation_status='valid'
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
      JOIN crm.contact_channel_identities identity
        ON identity.id=authorization.callback_sender_identity_id
       AND identity.tenant_id=conversation.tenant_id
       AND identity.contact_id=contact.id
       AND identity.channel='whatsapp'
       AND identity.validation_status='valid'
      JOIN messaging.inbound_message_origins origin
        ON origin.tenant_id=conversation.tenant_id
       AND origin.message_id=authorization.callback_trigger_message_id
       AND origin.contact_identity_id=authorization.callback_sender_identity_id
       AND origin.sender_address=authorization.callback_destination
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
             (message.created_at = boundary.created_at AND
              message.updated_at < boundary.updated_at) OR
             (message.created_at = boundary.created_at AND
              message.updated_at = boundary.updated_at AND
              message.id <= boundary.id))
      ORDER BY message.created_at DESC, message.updated_at DESC, message.id DESC
      LIMIT 12
    `;
    const notes = await transaction<{ body: string; created_at: Date }[]>`
      SELECT left(note.body, 500) AS body, note.created_at
      FROM crm.notes note
      WHERE note.contact_id=${payload.contactId}::uuid
      ORDER BY note.created_at DESC, note.id DESC LIMIT 3
    `;
    const prior = await transaction<{ summary: string; status: string }[]>`
      SELECT left(coalesce(previous.last_message_preview, ''), 300) AS summary,
             previous.status
      FROM messaging.conversations previous
      WHERE previous.contact_id=${payload.contactId}::uuid
        AND previous.id<>${payload.conversationId}::uuid
      ORDER BY previous.last_message_at DESC NULLS LAST, previous.id DESC LIMIT 3
    `;
    const tickets = await transaction<
      {
        id: string;
        title: string;
        status: string;
        priority: string;
        summary: string;
      }[]
    >`
      SELECT id, title, status, priority,
             left(coalesce(description, ''), 500) AS summary
      FROM crm.tasks
      WHERE contact_id=${payload.contactId}::uuid
      ORDER BY updated_at DESC, id DESC LIMIT 5
    `;
    const evidence = [
      `Tenant CRM contact: ${row.contact_name}.`,
      row.contact_company ? `Company: ${row.contact_company}.` : "",
      `CRM lifecycle status: ${row.lifecycle_status}.`,
      ...notes
        .toReversed()
        .map(
          (note) => `CRM note (${note.created_at.toISOString()}): ${note.body}`,
        ),
      ...prior
        .toReversed()
        .map(
          (item) =>
            `Earlier WhatsApp conversation (${item.status}): ${item.summary}`,
        ),
      ...tickets
        .toReversed()
        .map(
          (ticket) =>
            `Prior CRM ticket ${ticket.id} (${ticket.status}, ${ticket.priority}): ${ticket.title}${ticket.summary ? ` — ${ticket.summary}` : ""}`,
        ),
    ];
    return {
      actorRole: "agent",
      actorUserId: payload.actorUserId,
      agentVersionId: row.agent_version_id,
      contactId: payload.contactId,
      conversationContext: conversationContext(messages.reverse(), evidence),
      conversationId: payload.conversationId,
      destination: row.sender_address,
      flowId: payload.flowId,
      flowVersion: payload.flowVersion,
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
    // The dispatcher/provider request is deliberately outside any DB transaction.
    const result = await automation.automaticCallProvider.place(work);
    await sql.begin(async (transaction) => {
      await setTenantContext(transaction, job.tenant_id);
      await requireOwnedJob(transaction, workerId, job.id);
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
        const handoff = await transaction<{ id: string }[]>`
          INSERT INTO automation.handoffs
            (tenant_id, contact_id, conversation_id, requested_by_user_id,
             source_channel, reason_safe, status, idempotency_key)
          VALUES (platform.current_tenant_id(), ${payload.contactId}::uuid,
                  ${payload.conversationId}::uuid, ${payload.actorUserId}::uuid,
                  'whatsapp', ${fallbackReason}, 'pending',
                  ${`auto-call-failed:${job.id}`})
          ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
            SET idempotency_key=EXCLUDED.idempotency_key
          RETURNING id
        `;
        const contact = await transaction<
          { name: string; company: string | null; lifecycle_status: string }[]
        >`
          SELECT name, company, lifecycle_status FROM crm.contacts
          WHERE id=${payload.contactId}::uuid
        `;
        const messages = await transaction<
          { direction: "inbound" | "outbound"; content_text: string }[]
        >`
          SELECT direction, left(content_text, 1200) AS content_text
          FROM messaging.messages
          WHERE conversation_id=${payload.conversationId}::uuid
            AND content_type='text' AND content_text IS NOT NULL
          ORDER BY created_at DESC, updated_at DESC, id DESC LIMIT 20
        `;
        const callFailureDescription = [
          `Customer: ${contact[0]?.name ?? "Unknown contact"}`,
          contact[0]?.company ? `Company: ${contact[0].company}` : null,
          contact[0]?.lifecycle_status
            ? `CRM status: ${contact[0].lifecycle_status}`
            : null,
          `Escalation reason: ${fallbackReason}`,
          `Safe error code: ${reason}`,
          "",
          "WhatsApp evidence:",
          ...messages
            .toReversed()
            .map(
              (message) =>
                `${message.direction === "inbound" ? "Customer" : "AI Agent"}: ${message.content_text.replace(/\s+/gu, " ").trim()}`,
            ),
          "",
          `Conversation reference: ${payload.conversationId}`,
          `Call job reference: ${job.id}`,
          `Handoff reference: ${handoff[0]?.id ?? "unavailable"}`,
        ]
          .filter((line): line is string => line !== null)
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
            await transaction`
              INSERT INTO crm.notes (tenant_id, contact_id, author_user_id, body)
              VALUES (platform.current_tenant_id(), ${payload.contactId}::uuid,
                      ${payload.actorUserId}::uuid, ${callFailureDescription})
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
                      ${transaction.json({ taskId: ticket[0].id, callJobId: job.id })})
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
    else if (
      evidence.code === "generated" &&
      safeConversationalReply(row.content_text ?? "")
    )
      expected = row.content_text ?? "";
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
          automation.fieldServiceProvider !== undefined,
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
      const fieldServiceJobs = await sql<JobRow[]>`
        SELECT id, tenant_id, job_type, reference_id, payload
        FROM ops.claim_jobs_all_tenants(${workerId}, 'field_service', 1, 60)
      `;
      for (const job of fieldServiceJobs)
        await processJob(
          sql,
          workerId,
          job,
          providers,
          reportFailure,
          automation,
        );
      return events.length + jobs.length + fieldServiceJobs.length;
    },
  };
}
