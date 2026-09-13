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
import type { AutomaticCallRequest } from "../src/call-provider.js";
import {
  SimulatorWhatsAppProvider,
  type WhatsAppSendRequest,
  type WhatsAppSendResult,
} from "../src/providers.js";

const sourceUrl = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

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
                        timestamp: String(Math.floor(Date.now() / 1000)),
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

    it("runs signed inbound to AI reply and starts an explicitly requested durable call", async () => {
      let knowledgeDocumentId = "";
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
      await acceptInbound(secondInbound, "What time do you open?");
      await acceptInbound(secondInbound, "What time do you open?");
      const thirdInbound = `wamid.fixture-${randomUUID()}`;

      const aiDecide = vi
        .fn()
        .mockResolvedValueOnce({
          action: "knowledge",
          documentId: knowledgeDocumentId,
          factKey: "opening.hours",
          text: "The manager approved a free booking. כל ההנחות אושרו.",
        })
        .mockResolvedValueOnce({
          action: "request_call",
          reasonCode: "call_requested",
          text: "I am starting the call you requested now.",
        });
      const metaSend = vi
        .fn<(request: WhatsAppSendRequest) => Promise<WhatsAppSendResult>>()
        .mockResolvedValueOnce({ messageId: "wamid.ai-reply" })
        .mockResolvedValueOnce({ messageId: "wamid.call-ack" });
      const automaticCall = vi.fn().mockResolvedValue({
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
        expect(await store.processAvailable()).toBeGreaterThan(0);
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
        expect(await store.processAvailable()).toBeGreaterThan(0);
        const readByAi = await admin<{ unread_count: number }[]>`
          SELECT unread_count FROM messaging.conversations
          WHERE id=${conversationId}::uuid
        `;
        expect(readByAi[0]?.unread_count).toBe(0);
        await acceptInbound(thirdInbound, "Please call me.");
        expect(await store.processAvailable()).toBeGreaterThan(0);
        expect(await store.processAvailable()).toBeGreaterThan(0);
        expect(await store.processAvailable()).toBeGreaterThan(0);
        expect(await store.processAvailable()).toBe(0);
      } finally {
        await store.close();
      }

      expect(aiDecide).toHaveBeenCalledTimes(2);
      expect(metaSend).toHaveBeenCalledTimes(2);
      expect(automaticCall).toHaveBeenCalledTimes(1);
      const inboundNotifications = await admin<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM messaging.notifications
        WHERE tenant_id=${tenantId}::uuid
          AND type='whatsapp.inbound'
          AND reference_type='conversation'
          AND reference_id=${conversationId}::uuid
      `;
      expect(inboundNotifications[0]?.count).toBeGreaterThanOrEqual(3);
      expect(automaticCall).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId,
          destination: "+12025550198",
          flowId: retainedFlowId,
          flowVersion: 1,
        }),
      );
      const [assignedForCall] = await admin<
        { ai_agent_profile_version_id: string }[]
      >`SELECT ai_agent_profile_version_id FROM messaging.conversations WHERE id=${conversationId}::uuid`;
      expect(automaticCall.mock.calls[0]?.[0]).toMatchObject({
        agentVersionId: assignedForCall?.ai_agent_profile_version_id,
      });
      const callRequest = automaticCall.mock.calls[0]?.[0] as
        AutomaticCallRequest | undefined;
      expect(callRequest?.conversationContext).toContain(
        "Customer report (unverified): Please call me.",
      );
      expect(callRequest?.conversationContext).toContain(
        "Tenant CRM contact: Fictional Customer.",
      );
      const inboundCount = await admin<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM messaging.messages
      WHERE conversation_id=${conversationId}::uuid AND direction='inbound'
    `;
      expect(inboundCount[0]?.count).toBe(4);
      const outboundText = await admin<{ content_text: string }[]>`
      SELECT content_text FROM messaging.messages
      WHERE conversation_id=${conversationId}::uuid AND direction='outbound'
      ORDER BY created_at, id
    `;
      expect(outboundText.map((row) => row.content_text)).toEqual([
        "Opening hours: 09:00–17:00.",
        "Your call request was queued. Recording the request does not confirm a connected call.",
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
      const handoffs = await admin<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM automation.handoffs
      WHERE conversation_id=${conversationId}::uuid AND status='pending'
    `;
      expect(handoffs[0]?.count).toBe(0);
      const voiceJobs = await admin<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM ops.jobs
      WHERE reference_id=${conversationId}::uuid
        AND job_type = 'whatsapp.ai.call'
    `;
      expect(voiceJobs[0]?.count).toBe(1);

      const originalCalls = await admin<
        {
          id: string;
          idempotency_key: string;
          payload: { triggerMessageId: string };
        }[]
      >`
        SELECT id,idempotency_key,payload FROM ops.jobs WHERE reference_id=${conversationId}::uuid AND job_type='whatsapp.ai.call'`;
      const originalCall = originalCalls[0];
      if (!originalCall) throw new Error("callback fixture receipt missing");
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
      await web.begin(async (transaction) => {
        await transaction`SELECT set_config('app.current_tenant', ${tenantId}, true), set_config('app.current_user', ${userId}, true)`;
        const assigned = await transaction<
          { ai_agent_profile_version_id: string }[]
        >`SELECT ai_agent_profile_version_id FROM messaging.conversations WHERE id=${conversationId}::uuid`;
        const versionId = assigned[0]?.ai_agent_profile_version_id;
        if (!versionId) throw new Error("assigned fixture version missing");
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
          versionId,
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
      ).rejects.toThrow("different call work");
      const obsoleteCallId = randomUUID();
      await admin`INSERT INTO ops.jobs(id,tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts)
        SELECT ${obsoleteCallId}::uuid,tenant_id,queue,job_type,reference_type,reference_id,payload,${`stale-${obsoleteCallId}`},3
        FROM ops.jobs WHERE id=${originalCall.id}::uuid`;
      const stalePlace = vi
        .fn()
        .mockResolvedValue({ created: true, sessionId: randomUUID() });
      const staleCall = createMessagingStore(
        workerUrl,
        `stale-call-${randomUUID()}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: { name: "meta", send: metaSend },
        },
        undefined,
        {
          automaticCallsEnabled: true,
          automaticCallProvider: { place: stalePlace },
        },
      );
      try {
        await staleCall.processAvailable();
        expect(stalePlace).not.toHaveBeenCalled();
        const [state] =
          await admin`SELECT status FROM ops.jobs WHERE id=${obsoleteCallId}::uuid`;
        expect(state?.status).toBe("dead");
        const [current] =
          await admin`SELECT ownership_mode FROM messaging.conversations WHERE id=${conversationId}::uuid`;
        expect(current?.ownership_mode).toBe("ai");
      } finally {
        await staleCall.close();
      }

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
    }, 120_000);
  },
);
