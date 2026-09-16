import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  acceptWhatsAppWebhook,
  createAgentProfileDraft,
  createCanonicalFlowDraft,
  createKnowledgeDraft,
  changeKnowledgePublication,
  ingestSimulatedInbound,
  publishAgentProfile,
  publishExecutableFlow,
  queueWhatsAppAutomaticCall,
  setConversationOwnership,
} from "@or-on/crm";

import { createMessagingStore } from "../src/database.js";
import {
  AutomaticCallProviderError,
  type AutomaticCallRequest,
} from "../src/call-provider.js";
import {
  SimulatorWhatsAppProvider,
  type WhatsAppSendRequest,
  type WhatsAppSendResult,
} from "../src/providers.js";

const sourceUrl = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

async function processUntilIdle(
  store: Readonly<{ processAvailable: () => Promise<number> }>,
  maximumPasses = 16,
): Promise<number> {
  let processed = 0;
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    const current = await store.processAvailable();
    processed += current;
    if (current === 0) return processed;
  }
  throw new Error("messaging worker did not become idle");
}

describe.skipIf(sourceUrl === undefined)(
  "isolated WhatsApp AI orchestration",
  () => {
    const databaseName = `oron_whatsapp_ai_${randomUUID().replaceAll("-", "")}`;
    const phoneNumberId = `fixture-phone-${randomUUID()}`;
    const appSecret = "fictional-whatsapp-ai-secret";
    let maintenance: postgres.Sql;
    let admin: postgres.Sql;
    let web: postgres.Sql;
    let worker: postgres.Sql;
    let workerUrl: string;
    const cleanup: (() => Promise<void>)[] = [];

    beforeAll(async () => {
      if (sourceUrl === undefined)
        throw new Error("explicit PostgreSQL test URL required");
      const url = new URL(sourceUrl);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("isolated worker tests require localhost PostgreSQL");
      url.pathname = "/postgres";
      maintenance = postgres(url.toString(), { max: 1 });
      cleanup.push(() => maintenance.end());
      await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
      cleanup.push(async () => {
        await maintenance.unsafe(
          `DROP DATABASE "${databaseName}" WITH (FORCE)`,
        );
      });

      url.pathname = `/${databaseName}`;
      const environment = {
        ...process.env,
        DATABASE_URL: url.toString(),
        ENABLE_REAL_WHATSAPP: "false",
        ENABLE_REAL_TELEPHONY: "false",
        WHATSAPP_ACCESS_TOKEN: "",
        WHATSAPP_APP_SECRET: "",
        DEV_AUTH_EMAIL: "operator@or-on.local",
        DEV_AUTH_PASSWORD_HASH: "$argon2id$isolated-test-not-a-login-hash",
      };
      execFileSync(
        "uv",
        [
          "run",
          "--no-sync",
          "alembic",
          "-c",
          "db/alembic/alembic.ini",
          "upgrade",
          "head",
        ],
        { cwd: root, env: environment, stdio: "pipe" },
      );
      execFileSync(
        "uv",
        ["run", "--no-sync", "python", "db/seeds/seed_development.py"],
        {
          cwd: root,
          env: environment,
          stdio: "pipe",
        },
      );

      admin = postgres(url.toString(), { max: 1 });
      cleanup.push(() => admin.end());
      url.searchParams.set("options", "-c role=platform_web");
      web = postgres(url.toString(), { max: 1 });
      cleanup.push(() => web.end());
      url.searchParams.set("options", "-c role=platform_messaging");
      workerUrl = url.toString();
      worker = postgres(workerUrl, { max: 1 });
      cleanup.push(() => worker.end());

      await admin`
      INSERT INTO messaging.channels
        (tenant_id, kind, provider, provider_account_id, display_address,
         status, configuration)
      VALUES (${tenantId}::uuid, 'whatsapp', 'meta', ${phoneNumberId},
              'Fictional Meta AI channel', 'active',
              ${admin.json({
                phoneNumberId,
                wabaId: "fixture-waba",
                graphApiVersion: "v26.0",
              })})
    `;
    }, 120_000);

    afterAll(async () => {
      for (const close of cleanup.reverse()) await close();
    });

    async function acceptInbound(
      messageId: string,
      text: string,
      timestamp = String(Math.floor(Date.now() / 1000)),
    ): Promise<void> {
      const rawBody = Buffer.from(
        JSON.stringify({
          entry: [
            {
              id: "fixture-waba",
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: phoneNumberId },
                    contacts: [{ profile: { name: "Fictional Customer" } }],
                    messages: [
                      {
                        id: messageId,
                        from: "12025550198",
                        type: "text",
                        timestamp,
                        text: { body: text },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
      const signature = `sha256=${createHmac("sha256", appSecret)
        .update(rawBody)
        .digest("hex")}`;
      await acceptWhatsAppWebhook(workerUrl, rawBody, signature, appSecret);
    }

    async function forgeMutableSenderMetadata(
      providerMessageId: string,
      identityId: string,
    ): Promise<void> {
      await admin`
        UPDATE messaging.messages
        SET provider_payload=jsonb_set(
          coalesce(provider_payload, '{}'::jsonb),
          '{senderIdentityId}', to_jsonb(${identityId}::text), true)
        WHERE tenant_id=${tenantId}::uuid
          AND provider='meta' AND provider_message_id=${providerMessageId}
      `;
    }

    it("runs signed inbound to AI reply and starts an explicitly requested durable call", async () => {
      let knowledgeDocumentId = "";
      let whatsAppAgentVersionId = "";
      let voiceAgentVersionId = "";
      let canonicalFlowDefinitionId = "";
      const firstInbound = `wamid.fixture-${randomUUID()}`;
      await acceptInbound(firstInbound, "Hello");
      const bootstrapStore = createMessagingStore(
        workerUrl,
        `bootstrap-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(() => Promise.reject(new Error("must not send"))),
          },
        },
      );
      try {
        expect(await bootstrapStore.processAvailable()).toBeGreaterThan(0);
      } finally {
        await bootstrapStore.close();
      }

      const conversation = await admin<{ id: string }[]>`
      SELECT conversation.id
      FROM messaging.conversations conversation
      JOIN messaging.channels channel ON channel.id = conversation.channel_id
      WHERE channel.provider_account_id = ${phoneNumberId}
    `;
      const conversationId = conversation[0]?.id;
      if (conversationId === undefined)
        throw new Error("inbound conversation was not created");
      const inboundIdentity = await admin<{ id: string }[]>`
        UPDATE crm.contact_channel_identities identity
        SET is_primary=false
        FROM messaging.conversations conversation
        WHERE conversation.id=${conversationId}::uuid
          AND identity.contact_id=conversation.contact_id
          AND identity.channel='whatsapp'
          AND identity.normalized_value='+12025550198'
        RETURNING identity.id
      `;
      const inboundIdentityId = inboundIdentity[0]?.id;
      if (inboundIdentityId === undefined)
        throw new Error("signed inbound identity was not persisted");
      // Consent belongs to the sender of the signed inbound request, not to a
      // different primary number that happens to share the CRM contact.
      const secondaryIdentities = await admin<{ id: string }[]>`
        INSERT INTO crm.contact_channel_identities
          (tenant_id, contact_id, channel, normalized_value, display_value,
           provider, provider_identity_id, validation_status, is_primary)
        SELECT ${tenantId}::uuid, conversation.contact_id, 'whatsapp',
               '+12025550199', '+12025550199', 'meta', '+12025550199',
               'valid', true
        FROM messaging.conversations conversation
        WHERE conversation.id=${conversationId}::uuid
        RETURNING id
      `;
      const secondaryIdentityId = secondaryIdentities[0]?.id;
      if (secondaryIdentityId === undefined)
        throw new Error("secondary WhatsApp identity fixture missing");
      const linkedTicketId = randomUUID();
      await admin`
        INSERT INTO crm.tasks
          (id, tenant_id, contact_id, created_by_user_id, title, description,
           status, priority)
        SELECT ${linkedTicketId}::uuid, ${tenantId}::uuid, conversation.contact_id,
               ${userId}::uuid, 'Fictional prior connectivity ticket',
               'Packet loss was reported on the office router.',
               'in_progress', 'high'
        FROM messaging.conversations conversation
        WHERE conversation.id=${conversationId}::uuid
      `;

      const retainedFlowId = randomUUID();
      await admin`
        INSERT INTO public.flows
          (flow_id, version, tenant_id, source, spec, components_version)
        VALUES (
          ${retainedFlowId}::uuid, 1, ${tenantId}::uuid, '{}',
          ${admin.json({
            id: retainedFlowId,
            version: 1,
            entry: "done",
            language: "he",
            nodes: [
              {
                name: "done",
                pre_actions: [{ type: "tts_say", text: "שלום" }],
                post_actions: [{ type: "end_conversation" }],
              },
            ],
          })},
          'fixture'
        )
      `;

      const simulatorAttempt = await web.begin(async (transaction) => {
        await transaction`
        SELECT set_config('app.current_tenant', ${tenantId}, true),
               set_config('app.current_user', ${userId}, true)
      `;
        const profileId = await createAgentProfileDraft(transaction, userId, {
          name: "Fictional WhatsApp assistant",
          systemPrompt: "Answer fictional customer questions safely.",
          channels: ["voice", "whatsapp"],
          locale: "en",
        });
        knowledgeDocumentId = await createKnowledgeDraft(transaction, userId, {
          title: "Fictional opening hours",
          content: "Fictional reviewed business hours.",
          facts: [
            { factKey: "opening.hours", value: "Opening hours: 09:00–17:00." },
          ],
          validFrom: "2026-01-01T00:00:00Z",
          validUntil: null,
        });
        await changeKnowledgePublication(
          transaction,
          userId,
          knowledgeDocumentId,
          "publish",
        );
        await transaction`UPDATE agents.agent_profile_versions SET knowledge_configuration=jsonb_build_object(
          'schemaVersion','1.0','sourceIds',jsonb_build_array((SELECT source_id::text FROM agents.knowledge_documents WHERE id=${knowledgeDocumentId}::uuid)))
          WHERE agent_profile_id=${profileId}::uuid AND published_at IS NULL`;
        expect(await publishAgentProfile(transaction, userId, profileId)).toBe(
          true,
        );
        const versions = await transaction<{ id: string }[]>`
        SELECT id FROM agents.agent_profile_versions
        WHERE agent_profile_id = ${profileId}::uuid AND published_at IS NOT NULL
      `;
        const versionId = versions[0]?.id;
        if (versionId === undefined)
          throw new Error("published version missing");
        whatsAppAgentVersionId = versionId;
        const voiceProfileId = await createAgentProfileDraft(
          transaction,
          userId,
          {
            name: "Fictional voice continuation agent",
            systemPrompt: "Continue the WhatsApp investigation by voice.",
            channels: ["voice"],
            locale: "en",
          },
        );
        expect(
          await publishAgentProfile(transaction, userId, voiceProfileId),
        ).toBe(true);
        const voiceVersions = await transaction<{ id: string }[]>`
          SELECT id FROM agents.agent_profile_versions
          WHERE agent_profile_id=${voiceProfileId}::uuid
            AND published_at IS NOT NULL
        `;
        voiceAgentVersionId = voiceVersions[0]?.id ?? "";
        if (!voiceAgentVersionId)
          throw new Error("published voice version missing");
        const flowDefinitionId = await createCanonicalFlowDraft(
          transaction,
          userId,
          `Fictional callback ${randomUUID()}`,
          versionId,
          {
            schemaVersion: "1.0",
            channels: ["voice", "whatsapp"],
            nodes: [
              { id: "start", type: "start" },
              {
                id: "call",
                type: "voice.call",
                configuration: {
                  flowId: retainedFlowId,
                  flowVersion: 1,
                  agentVersionId: voiceAgentVersionId,
                },
              },
              {
                id: "message",
                type: "message.send",
                configuration: { text: "Fictional WhatsApp path." },
              },
              { id: "end", type: "end" },
            ],
            edges: [
              { id: "a", source: "start", target: "call" },
              { id: "b", source: "start", target: "message" },
              { id: "c", source: "call", target: "end" },
              { id: "d", source: "message", target: "end" },
            ],
          },
        );
        expect(
          await publishExecutableFlow(transaction, userId, flowDefinitionId),
        ).toBe(true);
        canonicalFlowDefinitionId = flowDefinitionId;
        await transaction`
          UPDATE crm.contacts SET voice_consent='granted'
          WHERE id=(SELECT contact_id FROM messaging.conversations
                    WHERE id=${conversationId}::uuid)
        `;
        const simulated = await ingestSimulatedInbound(transaction, userId, {
          providerEventId: `simulated-${randomUUID()}`,
          providerMessageId: `simulated-${randomUUID()}`,
          from: "+12025550197",
          profileName: "Fictional simulator contact",
          text: "Please call me now.",
        });
        const simulatedTrigger = await transaction<
          { id: string; contact_id: string }[]
        >`
          SELECT message.id, conversation.contact_id
          FROM messaging.messages message
          JOIN messaging.conversations conversation
            ON conversation.id=message.conversation_id
          WHERE message.conversation_id=${simulated.conversationId}::uuid
            AND message.direction='inbound'
          ORDER BY message.created_at DESC, message.id DESC LIMIT 1
        `;
        const simulatedRow = simulatedTrigger[0];
        if (simulatedRow === undefined)
          throw new Error("simulated trigger missing");
        await transaction`
          UPDATE crm.contacts SET voice_consent='granted'
          WHERE id=${simulatedRow.contact_id}::uuid
        `;
        expect(
          await setConversationOwnership(
            transaction,
            simulated.conversationId,
            userId,
            "ai",
            versionId,
          ),
        ).toBe(true);
        return {
          conversationId: simulated.conversationId,
          triggerMessageId: simulatedRow.id,
        };
      });

      await worker.begin(async (transaction) => {
        await transaction`
          SELECT set_config('app.current_tenant', ${tenantId}, true),
                 set_config('app.current_user', ${userId}, true)
        `;
        await expect(
          queueWhatsAppAutomaticCall(
            transaction,
            userId,
            simulatorAttempt.conversationId,
            simulatorAttempt.triggerMessageId,
            `simulator-call-${randomUUID()}`,
          ),
        ).rejects.toThrow("automatic call policy");
      });

      const disabledInbound = `wamid.fixture-${randomUUID()}`;
      await acceptInbound(
        disabledInbound,
        "This must not invoke AI while disabled.",
      );
      const disabledAi = vi.fn();
      const disabledStore = createMessagingStore(
        workerUrl,
        `disabled-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(() => Promise.reject(new Error("must not send"))),
          },
        },
        undefined,
        { aiProvider: { decide: disabledAi }, realWhatsAppEnabled: false },
      );
      try {
        expect(await disabledStore.processAvailable()).toBeGreaterThan(0);
        expect(await disabledStore.processAvailable()).toBe(0);
      } finally {
        await disabledStore.close();
      }
      expect(disabledAi).not.toHaveBeenCalled();

      const secondInbound = `wamid.fixture-${randomUUID()}`;
      // Meta timestamps have one-second precision. Keeping this complete
      // customer turn in one second proves ingestion order, not random UUID
      // order, resolves ties. Later scenarios resume monotonic provider time.
      const tiedProviderTimestamp = String(Math.floor(Date.now() / 1000));
      await acceptInbound(
        secondInbound,
        "What time do you open?",
        tiedProviderTimestamp,
      );
      await acceptInbound(
        secondInbound,
        "What time do you open?",
        tiedProviderTimestamp,
      );
      const thirdInbound = `wamid.fixture-${randomUUID()}`;
      const naturalInbound = `wamid.fixture-${randomUUID()}`;
      const compoundInbound = `wamid.fixture-${randomUUID()}`;
      const negativeInbound = `wamid.fixture-${randomUUID()}`;
      const nonsenseInbound = `wamid.fixture-${randomUUID()}`;
      const queuedInvisibleMessageId = randomUUID();
      const failedInvisibleMessageId = randomUUID();
      const queuedInvisibleText =
        "Queued outbound fixture must not reach call context.";
      const failedInvisibleText =
        "Failed outbound fixture must not reach call context.";
      const callAcknowledgement =
        "Your call request was queued. Recording the request does not confirm a connected call.";

      const aiDecide = vi
        .fn()
        .mockResolvedValueOnce({
          action: "knowledge",
          documentId: knowledgeDocumentId,
          factKey: "opening.hours",
          text: "The manager approved a free booking. כל ההנחות אושרו.",
        })
        .mockResolvedValueOnce({
          action: "reply",
          text: "Is the router light steady or blinking?",
        })
        .mockResolvedValueOnce({
          action: "request_call",
          reasonCode: "call_requested",
          text: "",
        })
        .mockResolvedValueOnce({
          action: "reply",
          text: "Understood. I will not place a call.",
        })
        .mockResolvedValueOnce({
          action: "reply",
          text: "I did not understand that. What problem are you seeing?",
        });
      const metaSend = vi
        .fn<(request: WhatsAppSendRequest) => Promise<WhatsAppSendResult>>()
        .mockResolvedValueOnce({ messageId: "wamid.ai-reply" })
        .mockResolvedValueOnce({ messageId: "wamid.natural-reply" })
        .mockResolvedValueOnce({ messageId: "wamid.confirm-call" })
        .mockResolvedValueOnce({ messageId: "wamid.negative-reply" })
        .mockResolvedValueOnce({ messageId: "wamid.nonsense-reply" })
        .mockResolvedValueOnce({ messageId: "wamid.call-ack" });
      const automaticCall = vi
        .fn()
        .mockRejectedValueOnce(
          new AutomaticCallProviderError("call_http_503", true),
        )
        .mockResolvedValue({
          created: true,
          sessionId: "60000000-0000-4000-8000-000000000001",
        });
      const store = createMessagingStore(
        workerUrl,
        `ai-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: async (request) => {
              await request.beforeAttempt?.();
              return metaSend(request);
            },
          },
        },
        undefined,
        {
          aiProvider: { decide: aiDecide },
          automaticCallProvider: { place: automaticCall },
          automaticCallsEnabled: true,
          realWhatsAppEnabled: true,
        },
      );
      try {
        expect(await processUntilIdle(store)).toBeGreaterThan(0);
        const automaticallyAssigned = await admin<
          {
            ownership_mode: string;
            ai_agent_profile_version_id: string | null;
          }[]
        >`
          SELECT ownership_mode, ai_agent_profile_version_id
          FROM messaging.conversations WHERE id=${conversationId}::uuid
        `;
        expect(automaticallyAssigned[0]).toMatchObject({
          ownership_mode: "ai",
        });
        expect(
          automaticallyAssigned[0]?.ai_agent_profile_version_id,
        ).not.toBeNull();
        const readByAi = await admin<{ unread_count: number }[]>`
          SELECT unread_count FROM messaging.conversations
          WHERE id=${conversationId}::uuid
        `;
        expect(readByAi[0]?.unread_count).toBe(0);
        await acceptInbound(
          naturalInbound,
          "The connection is unstable after restarting the router.",
          tiedProviderTimestamp,
        );
        expect(await store.processAvailable()).toBeGreaterThan(0);
        await forgeMutableSenderMetadata(naturalInbound, secondaryIdentityId);
        expect(await processUntilIdle(store)).toBeGreaterThan(0);
        await acceptInbound(
          compoundInbound,
          "The connection is still unstable, so please call me now.",
          tiedProviderTimestamp,
        );
        expect(await processUntilIdle(store)).toBeGreaterThan(0);
        expect(automaticCall).not.toHaveBeenCalled();
        await acceptInbound(
          negativeInbound,
          "Do not call me.",
          tiedProviderTimestamp,
        );
        expect(await processUntilIdle(store)).toBeGreaterThan(0);
        expect(automaticCall).not.toHaveBeenCalled();
        await acceptInbound(
          nonsenseInbound,
          "purple triangles argue with seven",
          tiedProviderTimestamp,
        );
        expect(await processUntilIdle(store)).toBeGreaterThan(0);
        expect(automaticCall).not.toHaveBeenCalled();
        await admin.begin(async (transaction) => {
          await transaction`
            INSERT INTO messaging.messages(
              id, tenant_id, conversation_id, direction, sender_type,
              sender_user_id, content_type, content_text, provider, status
            ) VALUES
              (${queuedInvisibleMessageId}::uuid, ${tenantId}::uuid,
               ${conversationId}::uuid, 'outbound', 'user', ${userId}::uuid, 'text',
               ${queuedInvisibleText}, 'meta', 'queued'),
              (${failedInvisibleMessageId}::uuid, ${tenantId}::uuid,
               ${conversationId}::uuid, 'outbound', 'user', ${userId}::uuid, 'text',
               ${failedInvisibleText}, 'meta', 'failed')
          `;
          await transaction`
            INSERT INTO messaging.outbound_requests(
              tenant_id, conversation_id, message_id, channel_id,
              recipient_identity_id, recipient_address, requested_by_user_id,
              provider, message_kind, explicitly_confirmed, status,
              idempotency_key, last_error_code, completed_at
            )
            SELECT ${tenantId}::uuid, conversation.id, fixture.message_id,
                   conversation.channel_id, ${inboundIdentityId}::uuid,
                   '+12025550198', ${userId}::uuid, 'meta', 'text', true,
                   fixture.status, fixture.idempotency_key,
                   CASE WHEN fixture.status='failed'
                     THEN 'outbound_processing_failed' END,
                   CASE WHEN fixture.status='failed'
                     THEN CURRENT_TIMESTAMP END
            FROM messaging.conversations conversation
            CROSS JOIN (VALUES
              (${queuedInvisibleMessageId}::uuid, 'queued',
               ${`invisible-${queuedInvisibleMessageId}`}),
              (${failedInvisibleMessageId}::uuid, 'failed',
               ${`invisible-${failedInvisibleMessageId}`})
            ) AS fixture(message_id, status, idempotency_key)
            WHERE conversation.tenant_id=${tenantId}::uuid
              AND conversation.id=${conversationId}::uuid
          `;
        });
        await acceptInbound(
          thirdInbound,
          "Please call me.",
          tiedProviderTimestamp,
        );
        expect(await store.processAvailable()).toBeGreaterThan(0);
        await forgeMutableSenderMetadata(thirdInbound, secondaryIdentityId);
        expect(await processUntilIdle(store)).toBeGreaterThan(0);
        const expeditedRetries = await admin<{ id: string }[]>`
          UPDATE ops.jobs SET available_at=CURRENT_TIMESTAMP
          WHERE tenant_id=${tenantId}::uuid
            AND reference_id=${conversationId}::uuid
            AND job_type='whatsapp.ai.call' AND status='retry'
          RETURNING id
        `;
        expect(expeditedRetries).toHaveLength(1);
        expect(await processUntilIdle(store)).toBeGreaterThan(0);
      } finally {
        await store.close();
      }

      expect(aiDecide).toHaveBeenCalledTimes(5);
      const firstAiRequest = aiDecide.mock.calls[0]?.[0] as
        | {
            contactContext?: {
              tickets?: { id: string; title: string }[];
              identity?: {
                matchedBy: string;
                knownBeforeConversation: boolean;
              };
            };
          }
        | undefined;
      expect(firstAiRequest?.contactContext?.tickets).toEqual([
        expect.objectContaining({
          id: linkedTicketId,
          title: "Fictional prior connectivity ticket",
        }),
      ]);
      expect(firstAiRequest?.contactContext?.identity).toMatchObject({
        matchedBy: "verified_whatsapp_identity",
        knownBeforeConversation: true,
      });
      expect(metaSend).toHaveBeenCalledTimes(6);
      expect(
        metaSend.mock.calls.every(
          ([request]) => request.recipient === "+12025550198",
        ),
      ).toBe(true);
      expect(automaticCall).toHaveBeenCalledTimes(2);
      const inboundNotifications = await admin<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM messaging.notifications
        WHERE tenant_id=${tenantId}::uuid
          AND type='whatsapp.inbound'
          AND reference_type='conversation'
          AND reference_id=${conversationId}::uuid
      `;
      expect(inboundNotifications[0]?.count).toBeGreaterThanOrEqual(7);
      expect(automaticCall).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId,
          destination: "+12025550198",
          flowId: retainedFlowId,
          flowVersion: 1,
        }),
      );
      expect(automaticCall.mock.calls[0]?.[0]).toMatchObject({
        agentVersionId: voiceAgentVersionId,
      });
      const callRequest = automaticCall.mock.calls[0]?.[0] as
        AutomaticCallRequest | undefined;
      expect(callRequest?.handoffId).toMatch(
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu,
      );
      for (const [request] of automaticCall.mock.calls) {
        expect(request).not.toHaveProperty("conversationContext");
        expect(JSON.stringify(request)).not.toContain(callAcknowledgement);
        expect(JSON.stringify(request)).not.toContain(queuedInvisibleText);
        expect(JSON.stringify(request)).not.toContain(failedInvisibleText);
      }
      const invisibleOutbound = await admin<
        { content_text: string; request_status: string; status: string }[]
      >`
        SELECT message.content_text, message.status,
               request.status AS request_status
        FROM messaging.messages message
        JOIN messaging.outbound_requests request
          ON request.tenant_id=message.tenant_id
         AND request.message_id=message.id
        WHERE message.tenant_id=${tenantId}::uuid
          AND message.conversation_id=${conversationId}::uuid
          AND message.id IN (${queuedInvisibleMessageId}::uuid,
                             ${failedInvisibleMessageId}::uuid)
      `;
      expect(invisibleOutbound).toHaveLength(2);
      expect(invisibleOutbound).toEqual(
        expect.arrayContaining([
          {
            content_text: queuedInvisibleText,
            request_status: "queued",
            status: "queued",
          },
          {
            content_text: failedInvisibleText,
            request_status: "failed",
            status: "failed",
          },
        ]),
      );
      await admin`
        DELETE FROM messaging.messages
        WHERE tenant_id=${tenantId}::uuid
          AND conversation_id=${conversationId}::uuid
          AND id IN (${queuedInvisibleMessageId}::uuid,
                     ${failedInvisibleMessageId}::uuid)
      `;
      const inboundCount = await admin<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM messaging.messages
      WHERE tenant_id=${tenantId}::uuid
        AND conversation_id=${conversationId}::uuid AND direction='inbound'
    `;
      expect(inboundCount[0]?.count).toBe(8);
      const outboundText = await admin<{ content_text: string }[]>`
      SELECT content_text FROM messaging.messages
      WHERE tenant_id=${tenantId}::uuid
        AND conversation_id=${conversationId}::uuid AND direction='outbound'
      ORDER BY created_at, id
    `;
      expect(outboundText.map((row) => row.content_text)).toEqual([
        "Opening hours: 09:00–17:00.",
        "Is the router light steady or blinking?",
        'To request a call, please reply in a separate message: "Please call me now."',
        "Understood. I will not place a call.",
        "I did not understand that. What problem are you seeing?",
        callAcknowledgement,
      ]);
      const ownership = await admin<
        { ownership_mode: string; handoff_reason_safe: string | null }[]
      >`
      SELECT ownership_mode, handoff_reason_safe
      FROM messaging.conversations WHERE id=${conversationId}::uuid
    `;
      expect(ownership[0]).toEqual({
        ownership_mode: "ai",
        handoff_reason_safe: null,
      });
      const retainedAttention = await admin<{ unread_count: number }[]>`
        SELECT unread_count FROM messaging.conversations
        WHERE id=${conversationId}::uuid
      `;
      expect(retainedAttention[0]?.unread_count).toBe(0);
      const handoffs = await admin<{ id: string; status: string }[]>`
        SELECT id, status FROM automation.handoffs
        WHERE conversation_id=${conversationId}::uuid AND status='pending'
      `;
      expect(handoffs).toEqual([
        { id: callRequest?.handoffId, status: "pending" },
      ]);
      const voiceJobs = await admin<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM ops.jobs
      WHERE reference_id=${conversationId}::uuid
        AND job_type = 'whatsapp.ai.call'
    `;
      expect(voiceJobs[0]?.count).toBe(1);

      const originalCalls = await admin<
        {
          callback_destination: string;
          callback_sender_identity_id: string;
          callback_trigger_message_id: string;
          id: string;
          idempotency_key: string;
          payload: {
            contactIdentityId: string;
            destination: string;
            triggerMessageId: string;
          };
        }[]
      >`
        SELECT id, idempotency_key, payload, callback_destination,
               callback_sender_identity_id, callback_trigger_message_id
        FROM ops.jobs
        WHERE reference_id=${conversationId}::uuid
          AND job_type='whatsapp.ai.call'`;
      const originalCall = originalCalls[0];
      if (!originalCall) throw new Error("callback fixture receipt missing");
      expect(originalCall.payload.contactIdentityId).toBe(inboundIdentityId);
      expect(originalCall.payload.destination).toBe("+12025550198");
      expect(originalCall.callback_sender_identity_id).toBe(inboundIdentityId);
      expect(originalCall.callback_destination).toBe("+12025550198");
      expect(originalCall.callback_trigger_message_id).toBe(
        originalCall.payload.triggerMessageId,
      );
      expect(callRequest?.idempotencyKey).toBe(
        `whatsapp-auto-call:${originalCall.callback_trigger_message_id}`,
      );
      expect(automaticCall.mock.calls[1]?.[0]).toMatchObject({
        idempotencyKey: callRequest?.idempotencyKey,
        jobId: originalCall.id,
      });
      await worker.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
        const replay = await queueWhatsAppAutomaticCall(
          transaction,
          userId,
          conversationId,
          originalCall.payload.triggerMessageId,
          originalCall.idempotency_key,
        );
        expect(replay).toMatchObject({ jobId: originalCall.id, queued: false });
      });
      await admin`
        UPDATE ops.jobs SET created_at=CURRENT_TIMESTAMP-INTERVAL '11 minutes'
        WHERE id=${originalCall.id}::uuid
      `;

      // A current identity record is mutable CRM state. Once the signed inbound
      // message has admitted work, changing that record must fail the queued
      // attempt instead of redirecting either the callback or its acknowledgement.
      const mutatedInbound = `wamid.fixture-${randomUUID()}`;
      const mutationDecide = vi.fn().mockResolvedValue({
        action: "request_call",
        reasonCode: "call_requested",
        text: "",
      });
      const mutationSend = vi
        .fn<(request: WhatsAppSendRequest) => Promise<WhatsAppSendResult>>()
        .mockResolvedValue({ messageId: "must-not-send-mutated-recipient" });
      const mutationCall = vi
        .fn()
        .mockResolvedValue({ created: true, sessionId: randomUUID() });
      const mutationStore = createMessagingStore(
        workerUrl,
        `recipient-mutation-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: { name: "meta", send: mutationSend },
        },
        undefined,
        {
          aiProvider: { decide: mutationDecide },
          automaticCallProvider: { place: mutationCall },
          automaticCallsEnabled: true,
          realWhatsAppEnabled: true,
        },
      );
      try {
        await acceptInbound(mutatedInbound, "Okay, please call me now.");
        expect(await mutationStore.processAvailable()).toBeGreaterThan(0);
        const triggers = await admin<{ id: string }[]>`
          SELECT id FROM messaging.messages
          WHERE tenant_id=${tenantId}::uuid AND provider='meta'
            AND provider_message_id=${mutatedInbound}
        `;
        const mutatedTriggerId = triggers[0]?.id ?? "";
        if (!mutatedTriggerId)
          throw new Error("recipient-mutation trigger was not persisted");
        const admitted = await admin<
          { callback_destination: string; count: number }[]
        >`
          SELECT min(callback_destination) AS callback_destination,
                 count(*)::integer AS count
          FROM ops.jobs
          WHERE tenant_id=${tenantId}::uuid
            AND job_type='whatsapp.ai.call'
            AND callback_trigger_message_id=${mutatedTriggerId}::uuid
          GROUP BY callback_trigger_message_id
        `;
        expect(admitted[0]).toEqual({
          callback_destination: "+12025550198",
          count: 1,
        });
        await forgeMutableSenderMetadata(mutatedInbound, secondaryIdentityId);
        await admin`
          UPDATE crm.contact_channel_identities
          SET normalized_value='+12025550196'
          WHERE id=${inboundIdentityId}::uuid
        `;
        expect(await processUntilIdle(mutationStore)).toBeGreaterThan(0);
        expect(mutationCall).not.toHaveBeenCalled();
        expect(mutationSend).not.toHaveBeenCalled();
        const failedCallback = await admin<
          { last_error_safe: string | null; status: string }[]
        >`
          SELECT status, last_error_safe FROM ops.jobs
          WHERE tenant_id=${tenantId}::uuid
            AND job_type='whatsapp.ai.call'
            AND callback_trigger_message_id=${mutatedTriggerId}::uuid
        `;
        expect(failedCallback[0]).toMatchObject({
          status: "dead",
          last_error_safe: "automatic call eligibility changed",
        });
        const failedReply = await admin<
          { last_error_code: string | null; recipient_address: string }[]
        >`
          SELECT request.last_error_code, request.recipient_address
          FROM messaging.outbound_requests request
          JOIN messaging.messages message ON message.id=request.message_id
          WHERE message.provider_payload#>>'{aiGrounding,triggerMessageId}'=${mutatedTriggerId}
        `;
        expect(failedReply[0]).toEqual({
          last_error_code: "outbound_eligibility_changed",
          recipient_address: "+12025550198",
        });
      } finally {
        await admin`
          UPDATE crm.contact_channel_identities
          SET normalized_value='+12025550198'
          WHERE id=${inboundIdentityId}::uuid
        `;
        await mutationStore.close();
      }
      await web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
        await setConversationOwnership(
          transaction,
          conversationId,
          userId,
          "human",
        );
        await setConversationOwnership(
          transaction,
          conversationId,
          userId,
          "ai",
          whatsAppAgentVersionId,
        );
      });
      await expect(
        worker.begin(async (transaction) => {
          await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
          return queueWhatsAppAutomaticCall(
            transaction,
            userId,
            conversationId,
            originalCall.payload.triggerMessageId,
            originalCall.idempotency_key,
          );
        }),
      ).rejects.toThrow("automatic call policy");
      const obsoleteCallId = randomUUID();
      await expect(
        admin`
          INSERT INTO ops.jobs(
            id, tenant_id, queue, job_type, reference_type, reference_id,
            payload, idempotency_key, max_attempts,
            callback_trigger_message_id, callback_sender_identity_id,
            callback_destination
          )
          SELECT ${obsoleteCallId}::uuid, tenant_id, queue, job_type,
                 reference_type, reference_id, payload,
                 ${`stale-${obsoleteCallId}`}, 3,
                 callback_trigger_message_id, callback_sender_identity_id,
                 callback_destination
          FROM ops.jobs WHERE id=${originalCall.id}::uuid
        `,
      ).rejects.toThrow("uq_jobs_whatsapp_callback_trigger");
      const cloned = await admin<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM ops.jobs
        WHERE id=${obsoleteCallId}::uuid
      `;
      expect(cloned[0]?.count).toBe(0);

      // Real repository projection and least-privilege worker, fake providers:
      // a source revoked after generation cannot escape from the outbound queue.
      const groundedDecide = vi.fn().mockResolvedValue({
        action: "knowledge",
        documentId: knowledgeDocumentId,
        factKey: "opening.hours",
        text: "forged receipt",
      });
      const delayedSend = vi
        .fn()
        .mockResolvedValue({ messageId: "must-not-send-revoked-fact" });
      const delayed = createMessagingStore(
        workerUrl,
        `grounding-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: { name: "meta", send: delayedSend },
        },
        undefined,
        { aiProvider: { decide: groundedDecide }, realWhatsAppEnabled: true },
      );
      try {
        await acceptInbound(
          `wamid.fixture-${randomUUID()}`,
          "What time do you open?",
        );
        await delayed.processAvailable();
        await web.begin(async (transaction) => {
          await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
          await changeKnowledgePublication(
            transaction,
            userId,
            knowledgeDocumentId,
            "revoke",
          );
        });
        await delayed.processAvailable();
        expect(delayedSend).not.toHaveBeenCalled();
        const failed = await admin<
          { last_error_code: string | null }[]
        >`SELECT last_error_code FROM messaging.outbound_requests
          WHERE conversation_id=${conversationId}::uuid ORDER BY created_at DESC LIMIT 1`;
        expect(failed[0]?.last_error_code).toBe("ai_evidence_changed");
      } finally {
        await delayed.close();
      }

      // A newer canonical inbound message invalidates the generation even when
      // ownership has not changed. The model cannot apply an older caller intent.
      const beforeSupersession = await admin<
        { count: number }[]
      >`SELECT count(*)::integer AS count FROM messaging.outbound_requests WHERE conversation_id=${conversationId}::uuid`;
      const supersededDecide = vi.fn().mockImplementation(async () => {
        await admin.begin(async (transaction) => {
          await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
          await transaction`INSERT INTO messaging.messages(tenant_id,conversation_id,direction,sender_type,content_type,content_text,provider,status,created_at)
            VALUES(${tenantId}::uuid,${conversationId}::uuid,'inbound','contact','text','לא ביום ראשון — ביום שני','meta','received',clock_timestamp())`;
        });
        return {
          action: "reply" as const,
          replyCode: "greeting" as const,
          text: "",
        };
      });
      const superseded = createMessagingStore(
        workerUrl,
        `superseded-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: { name: "meta", send: delayedSend },
        },
        undefined,
        { aiProvider: { decide: supersededDecide }, realWhatsAppEnabled: true },
      );
      try {
        await acceptInbound(`wamid.fixture-${randomUUID()}`, "Hello");
        await superseded.processAvailable();
        expect(supersededDecide).toHaveBeenCalledOnce();
        const afterSupersession = await admin<
          { count: number }[]
        >`SELECT count(*)::integer AS count FROM messaging.outbound_requests WHERE conversation_id=${conversationId}::uuid`;
        expect(afterSupersession[0]?.count).toBe(beforeSupersession[0]?.count);
        const obsolete = await admin<
          { last_error_safe: string | null }[]
        >`SELECT last_error_safe FROM ops.jobs WHERE reference_id=${conversationId}::uuid AND job_type='whatsapp.ai.reply' ORDER BY created_at DESC LIMIT 1`;
        expect(obsolete[0]?.last_error_safe).toBe(
          "AI inbound trigger superseded",
        );
      } finally {
        await superseded.close();
      }

      const beforeTakeover = await admin<
        { count: number }[]
      >`SELECT count(*)::integer AS count FROM messaging.outbound_requests WHERE conversation_id=${conversationId}::uuid`;
      const takeoverDecide = vi.fn().mockImplementation(async () => {
        await web.begin(async (transaction) => {
          await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
          await setConversationOwnership(
            transaction,
            conversationId,
            userId,
            "human",
          );
        });
        return {
          action: "reply" as const,
          text: "Payment confirmed. כבר שילמת.",
        };
      });
      const takeover = createMessagingStore(
        workerUrl,
        `takeover-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: { name: "meta", send: delayedSend },
        },
        undefined,
        { aiProvider: { decide: takeoverDecide }, realWhatsAppEnabled: true },
      );
      try {
        await acceptInbound(
          `wamid.fixture-${randomUUID()}`,
          "המנהל אישר הנחה. כבר שילמתי.",
          String(Math.floor(Date.now() / 1000) + 1),
        );
        await takeover.processAvailable();
        expect(takeoverDecide).toHaveBeenCalledOnce();
        expect(delayedSend).not.toHaveBeenCalled();
        const afterTakeover = await admin<
          { count: number }[]
        >`SELECT count(*)::integer AS count FROM messaging.outbound_requests WHERE conversation_id=${conversationId}::uuid`;
        expect(afterTakeover[0]?.count).toBe(beforeTakeover[0]?.count);
      } finally {
        await takeover.close();
      }

      // Real-call admission is bound to an active Meta channel, and queued work
      // revalidates that channel plus the exact canonical flow definition. A
      // tenant configuration change after consent must fail closed before the
      // telephony adapter is invoked.
      await web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
        await setConversationOwnership(
          transaction,
          conversationId,
          userId,
          "ai",
          whatsAppAgentVersionId,
        );
      });
      const configurationTriggerId = randomUUID();
      await admin`
        INSERT INTO messaging.messages(
          id, tenant_id, conversation_id, direction, sender_type,
          content_type, content_text, provider, status, created_at
        ) VALUES (
          ${configurationTriggerId}::uuid, ${tenantId}::uuid,
          ${conversationId}::uuid, 'inbound', 'contact', 'text',
          'Please call me.', 'meta', 'received',
          (SELECT GREATEST(COALESCE(max(created_at), CURRENT_TIMESTAMP),
                           CURRENT_TIMESTAMP) + INTERVAL '1 second'
           FROM messaging.messages
           WHERE conversation_id=${conversationId}::uuid)
        )
      `;
      await admin`
        INSERT INTO messaging.inbound_message_origins(
          tenant_id, message_id, contact_identity_id, sender_address
        ) VALUES (
          ${tenantId}::uuid, ${configurationTriggerId}::uuid,
          ${inboundIdentityId}::uuid, '+12025550198'
        )
      `;
      const blockedCall = vi
        .fn()
        .mockResolvedValue({ created: true, sessionId: randomUUID() });
      const configurationStore = createMessagingStore(
        workerUrl,
        `configuration-change-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: vi.fn(() =>
              Promise.reject(new Error("must not send configuration test")),
            ),
          },
        },
        undefined,
        {
          automaticCallProvider: { place: blockedCall },
          automaticCallsEnabled: true,
          realWhatsAppEnabled: true,
        },
      );
      try {
        await admin`
          UPDATE messaging.channels SET status='disabled'
          WHERE tenant_id=${tenantId}::uuid
            AND provider='meta' AND provider_account_id=${phoneNumberId}
        `;
        await expect(
          worker.begin(async (transaction) => {
            await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
            return queueWhatsAppAutomaticCall(
              transaction,
              userId,
              conversationId,
              configurationTriggerId,
              `disabled-channel-${configurationTriggerId}`,
            );
          }),
        ).rejects.toThrow("automatic call policy");
        const disabledChannelJobs = await admin<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM ops.jobs
          WHERE tenant_id=${tenantId}::uuid
            AND job_type='whatsapp.ai.call'
            AND callback_trigger_message_id=${configurationTriggerId}::uuid
        `;
        expect(disabledChannelJobs[0]?.count).toBe(0);

        await admin`
          UPDATE messaging.channels SET status='active'
          WHERE tenant_id=${tenantId}::uuid
            AND provider='meta' AND provider_account_id=${phoneNumberId}
        `;
        const queuedForDisabledChannel = await worker.begin(
          async (transaction) => {
            await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
            return queueWhatsAppAutomaticCall(
              transaction,
              userId,
              conversationId,
              configurationTriggerId,
              `channel-state-${configurationTriggerId}`,
            );
          },
        );
        expect(queuedForDisabledChannel.queued).toBe(true);
        await admin`
          UPDATE messaging.channels SET status='disabled'
          WHERE tenant_id=${tenantId}::uuid
            AND provider='meta' AND provider_account_id=${phoneNumberId}
        `;
        expect(await processUntilIdle(configurationStore)).toBeGreaterThan(0);
        expect(blockedCall).not.toHaveBeenCalled();
        const disabledChannelJob = await admin<
          { last_error_safe: string | null; status: string }[]
        >`
          SELECT status, last_error_safe FROM ops.jobs
          WHERE id=${queuedForDisabledChannel.jobId}::uuid
        `;
        expect(disabledChannelJob[0]).toMatchObject({
          status: "dead",
          last_error_safe: "automatic call eligibility changed",
        });

        await admin`
          UPDATE messaging.channels SET status='active'
          WHERE tenant_id=${tenantId}::uuid
            AND provider='meta' AND provider_account_id=${phoneNumberId}
        `;
        await web.begin(async (transaction) => {
          await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
          await setConversationOwnership(
            transaction,
            conversationId,
            userId,
            "ai",
            whatsAppAgentVersionId,
          );
        });
        const archivedFlowTriggerId = randomUUID();
        await admin`
          INSERT INTO messaging.messages(
            id, tenant_id, conversation_id, direction, sender_type,
            content_type, content_text, provider, status, created_at
          ) VALUES (
            ${archivedFlowTriggerId}::uuid, ${tenantId}::uuid,
            ${conversationId}::uuid, 'inbound', 'contact', 'text',
            'Please call me.', 'meta', 'received',
            (SELECT GREATEST(COALESCE(max(created_at), CURRENT_TIMESTAMP),
                             CURRENT_TIMESTAMP) + INTERVAL '1 second'
             FROM messaging.messages
             WHERE conversation_id=${conversationId}::uuid)
          )
        `;
        await admin`
          INSERT INTO messaging.inbound_message_origins(
            tenant_id, message_id, contact_identity_id, sender_address
          ) VALUES (
            ${tenantId}::uuid, ${archivedFlowTriggerId}::uuid,
            ${inboundIdentityId}::uuid, '+12025550198'
          )
        `;
        const queuedForArchivedFlow = await worker.begin(
          async (transaction) => {
            await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
            return queueWhatsAppAutomaticCall(
              transaction,
              userId,
              conversationId,
              archivedFlowTriggerId,
              `archived-flow-${archivedFlowTriggerId}`,
            );
          },
        );
        expect(queuedForArchivedFlow.queued).toBe(true);
        await admin`
          UPDATE automation.flow_definitions
          SET archived_at=CURRENT_TIMESTAMP
          WHERE id=${canonicalFlowDefinitionId}::uuid
            AND tenant_id=${tenantId}::uuid
        `;
        expect(await processUntilIdle(configurationStore)).toBeGreaterThan(0);
        expect(blockedCall).not.toHaveBeenCalled();
        const archivedFlowJob = await admin<
          { last_error_safe: string | null; status: string }[]
        >`
          SELECT status, last_error_safe FROM ops.jobs
          WHERE id=${queuedForArchivedFlow.jobId}::uuid
        `;
        expect(archivedFlowJob[0]).toMatchObject({
          status: "dead",
          last_error_safe: "automatic call eligibility changed",
        });
        const validPinnedJob = await admin<{ status: string }[]>`
          SELECT status FROM ops.jobs WHERE id=${originalCall.id}::uuid
        `;
        expect(validPinnedJob[0]?.status).toBe("succeeded");
      } finally {
        await admin`
          UPDATE messaging.channels SET status='active'
          WHERE tenant_id=${tenantId}::uuid
            AND provider='meta' AND provider_account_id=${phoneNumberId}
        `;
        await admin`
          UPDATE automation.flow_definitions SET archived_at=NULL
          WHERE id=${canonicalFlowDefinitionId}::uuid
            AND tenant_id=${tenantId}::uuid
        `;
        await configurationStore.close();
      }
    }, 120_000);
  },
);
