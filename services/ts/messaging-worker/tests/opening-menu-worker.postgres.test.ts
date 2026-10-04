import { ingestWhatsAppStatus } from "@or-on/crm";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { openingMenuBusinessJobAllowed } from "../src/opening-menu-database.js";
import type { WhatsAppAiRequest } from "../src/ai-provider.js";
import { createMessagingStore } from "../src/database.js";
import {
  WhatsAppProviderError,
  SimulatorWhatsAppProvider,
} from "../src/providers.js";
const url = process.env.OPENING_MENU_TEST_DATABASE_URL;
describe.skipIf(!url)("owned canonical opening-menu worker", () => {
  it.each(["success", "rateLimit", "firstVideo", "firstAudio"])(
    "%s canonical ingress fences menu, AI, service and physical retries",
    async (scenario) => {
      if (!url) throw new Error("Owned fixture required");
      const target = new URL(url);
      if (
        target.hostname !== "127.0.0.1" ||
        target.port !== "55480" ||
        !/^\/oron_crm_[a-f0-9]{32}$/.test(target.pathname)
      )
        throw new Error("Owned loopback fixture only");
      const admin = postgres(url, { max: 2, prepare: false });
      const config = await admin<
        {
          tenant_id: string;
          channel_id: string;
          agent_version_id: string;
          flow_version_id: string;
        }[]
      >`SELECT * FROM platform.whatsapp_opening_menu_configuration WHERE enabled LIMIT 1`;
      const cfg = config[0];
      if (!cfg) throw new Error("Prepared owned menu fixture required");
      const caseId = randomUUID(),
        summaryId = randomUUID(),
        summaryJob = randomUUID();
      const contact = randomUUID(),
        conversation = randomUUID(),
        sender = `+1555${Date.now().toString().slice(-7)}`;
      const channel = (
        await admin<
          { provider_account_id: string }[]
        >`SELECT provider_account_id FROM messaging.channels WHERE id=${cfg.channel_id}::uuid`
      )[0];
      if (!channel) throw new Error("Owned channel missing");
      const requests: WhatsAppAiRequest[] = [];
      let modelCalls = 0,
        extractionCalls = 0,
        sends = 0;
      target.searchParams.set("options", "-c role=platform_messaging");
      const store = createMessagingStore(
        target.toString(),
        `menu-${conversation}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            verifyTemplate: () => Promise.resolve(true),
            send: async (request) => {
              await request.beforeAttempt?.();
              request.onAttemptStarted?.();
              sends++;
              if (scenario === "rateLimit")
                throw new WhatsAppProviderError(
                  "rate_limit_deferred",
                  true,
                  429,
                  undefined,
                  100_000,
                );
              return {
                messageId: `synthetic-menu-${conversation}${sends > 1 ? `-${String(sends)}` : ""}`,
              };
            },
          },
        },
        undefined,
        {
          realWhatsAppEnabled: true,
          aiProvider: {
            decide: (request) => {
              requests.push(request);
              modelCalls++;
              return Promise.resolve({
                action: "reply" as const,
                text: "Unexpected AI",
              });
            },
          },
          fieldServiceProvider: {
            providerName: "synthetic",
            modelName: "synthetic",
            extractIntake: () => {
              extractionCalls++;
              return Promise.reject(new Error("Unexpected extraction"));
            },
            extractProductLabel: () => {
              extractionCalls++;
              return Promise.reject(new Error("Unexpected OCR"));
            },
            summarizeEvidence: () => {
              extractionCalls++;
              return Promise.reject(new Error("Unexpected summary"));
            },
          },
        },
      );
      try {
        await admin.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant',${cfg.tenant_id},true)`;
          const users = await tx<
            { user_id: string }[]
          >`SELECT user_id FROM public.memberships WHERE tenant_id=${cfg.tenant_id}::uuid AND role='owner' LIMIT 1`;
          const user = users[0]?.user_id;
          if (!user) throw new Error("Owned user missing");
          await tx`INSERT INTO crm.contacts(id,tenant_id,name,created_by_user_id,whatsapp_consent) VALUES(${contact}::uuid,${cfg.tenant_id}::uuid,'Fictional opening menu',${user}::uuid,'granted')`;
          await tx`INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,display_value,validation_status,is_primary) VALUES(${cfg.tenant_id}::uuid,${contact}::uuid,'whatsapp',${sender},${sender},'valid',true)`;
          await tx`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) VALUES(${conversation}::uuid,${cfg.tenant_id}::uuid,${cfg.channel_id}::uuid,${contact}::uuid,'open','ai',${cfg.agent_version_id}::uuid,${user}::uuid,clock_timestamp())`;
          await tx`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at) VALUES(${cfg.tenant_id}::uuid,'field_service',true,true,clock_timestamp()) ON CONFLICT(tenant_id,feature_key) DO UPDATE SET available=true,enabled=true`;
          await tx`UPDATE platform.tenant_configuration_releases SET configuration=jsonb_set(configuration,'{features}',${tx.json(["agents", "contacts", "whatsapp", "leads", "tickets", "field_service"])}) WHERE tenant_id=${cfg.tenant_id}::uuid AND status='published'`;
          await tx`INSERT INTO platform.machine_tool_grants(tenant_id,principal_id,agent_version_id,flow_version_id,capability,enabled) SELECT ${cfg.tenant_id}::uuid,principal_id,${cfg.agent_version_id}::uuid,${cfg.flow_version_id}::uuid,'service.intake',true FROM platform.tenant_ai_execution_bindings WHERE tenant_id=${cfg.tenant_id}::uuid ON CONFLICT(tenant_id,principal_id,agent_version_id,capability) DO UPDATE SET enabled=true`;
          await tx`INSERT INTO service.tenant_configuration(tenant_id,enabled,whatsapp_intake_enabled) VALUES(${cfg.tenant_id}::uuid,true,true) ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,whatsapp_intake_enabled=true`;
          await tx`INSERT INTO service.cases(id,tenant_id,reference,customer_contact_id,title,fault_description,source) VALUES(${caseId}::uuid,${cfg.tenant_id}::uuid,${caseId},${contact}::uuid,'Fictional menu case','Fictional','whatsapp')`;
          await tx`INSERT INTO service.case_summaries(id,tenant_id,case_id,source_kind,source_reference_id) VALUES(${summaryId}::uuid,${cfg.tenant_id}::uuid,${caseId}::uuid,'whatsapp',${conversation}::uuid)`;
          await tx`INSERT INTO ops.jobs(id,tenant_id,queue,job_type,reference_type,reference_id,payload,status,priority) VALUES(${summaryJob}::uuid,${cfg.tenant_id}::uuid,'messaging','field_service.summary','case_summary',${summaryId}::uuid,${tx.json({ summaryId, caseId, sourceKind: "whatsapp", sourceReferenceId: conversation })},'queued',10)`;
        });
        for (let n = 0; n < 2; n++) {
          const message = randomUUID();
          await admin`SELECT ops.accept_whatsapp_inbound(${channel.provider_account_id},${message},${scenario === "firstVideo" ? "whatsapp.message.video" : scenario === "firstAudio" ? "whatsapp.message.audio" : "whatsapp.message.text"},${admin.json(
            {
              providerAccountId: channel.provider_account_id,
              providerEventId: message,
              providerMessageId: message,
              from: sender,
              profileName: "Fictional menu",
              text: scenario.startsWith("first") ? "" : "Hello support",
              contentType:
                scenario === "firstVideo"
                  ? "video"
                  : scenario === "firstAudio"
                    ? "audio"
                    : "text",
              ...(scenario.startsWith("first")
                ? {
                    media: {
                      id: randomUUID(),
                      mimeType:
                        scenario === "firstVideo" ? "video/mp4" : "audio/ogg",
                    },
                  }
                : {}),
              occurredAt: new Date().toISOString(),
            },
          )})`;
        }
        for (let pass = 0; pass < 12; pass++) {
          await store.processAvailable();
          await store.drainReplies();
        }
        expect(sends).toBe(1);
        expect(modelCalls).toBe(0);
        expect(extractionCalls).toBe(0);
        expect(
          (
            await admin<
              { status: string; summary: string | null }[]
            >`SELECT status,summary FROM service.case_summaries WHERE id=${summaryId}::uuid`
          )[0],
        ).toEqual({ status: "failed", summary: null });
        const jobs = await admin<
          { job_type: string; status: string }[]
        >`SELECT job_type,status FROM ops.jobs WHERE tenant_id=${cfg.tenant_id}::uuid AND (reference_id=${conversation}::uuid OR payload->>'conversationId'=${conversation})`;
        if (scenario.startsWith("first")) {
          expect(
            jobs.some(
              (j) =>
                j.job_type === "whatsapp.opening_menu" &&
                j.status === "succeeded",
            ),
          ).toBe(true);
          const menuHistory = await admin<
            { content_type: string }[]
          >`SELECT content_type FROM messaging.messages WHERE conversation_id=${conversation}::uuid AND direction='outbound' AND structured_content ? 'openingMenuGeneration'`;
          expect(menuHistory).toEqual([{ content_type: "template" }]);
          return; // Media file/ASR verification belongs to its dedicated configured-storage suite.
        }
        expect(
          jobs.some((j) => j.job_type === "field_service.intake.extract"),
        ).toBe(true);
        if (scenario === "rateLimit") {
          const retry = await admin<
            { remaining: number }[]
          >`SELECT extract(epoch FROM available_at-clock_timestamp())::double precision AS remaining FROM ops.jobs WHERE tenant_id=${cfg.tenant_id}::uuid AND status='retry' AND (reference_id=${conversation}::uuid OR payload->>'conversationId'=${conversation})`;
          expect(retry).toHaveLength(1);
          expect(retry[0]?.remaining).toBeGreaterThan(95);
          expect(
            (
              await admin<
                { outcome: string }[]
              >`SELECT outcome FROM platform.whatsapp_opening_menu_operations WHERE conversation_id=${conversation}::uuid AND outcome IS NOT NULL`
            )[0]?.outcome,
          ).toBe("failed");
          await store.processAvailable();
          expect(sends).toBe(1);
          return;
        }
        expect(jobs.every((j) => j.status === "succeeded")).toBe(true);
        const history = await admin<
          { sender_type: string; provider_message_id: string }[]
        >`SELECT sender_type,provider_message_id FROM messaging.messages WHERE conversation_id=${conversation}::uuid AND direction='outbound'`;
        expect(history).toEqual([
          {
            sender_type: "system",
            provider_message_id: `synthetic-menu-${conversation}`,
          },
        ]);
        const status = {
          providerAccountId: channel.provider_account_id,
          providerEventId: randomUUID(),
          providerMessageId: `synthetic-menu-${conversation}`,
          status: "read" as const,
          occurredAt: new Date().toISOString(),
        };
        await admin.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant',${cfg.tenant_id},true)`;
          expect(await ingestWhatsAppStatus(tx, status)).toBe(true);
          expect(await ingestWhatsAppStatus(tx, status)).toBe(false);
        });
        await expect(
          admin.begin(async (tx) => {
            await tx`SELECT set_config('app.current_tenant',${cfg.tenant_id},true)`;
            await ingestWhatsAppStatus(tx, {
              ...status,
              providerEventId: randomUUID(),
              providerAccountId: "wrong-synthetic-account",
            });
          }),
        ).rejects.toThrow("unknown Meta message");
        expect(
          (
            await admin<
              { status: string }[]
            >`SELECT status FROM messaging.messages WHERE conversation_id=${conversation}::uuid AND direction='outbound'`
          )[0]?.status,
        ).toBe("read");
        const state = (
          await admin<
            { generation: string }[]
          >`SELECT generation FROM platform.whatsapp_opening_menu_state WHERE tenant_id=${cfg.tenant_id}::uuid AND conversation_id=${conversation}::uuid`
        )[0];
        if (!state) throw new Error("Canonical menu missing");
        const choice = randomUUID();
        await admin`SELECT ops.accept_whatsapp_inbound(${channel.provider_account_id},${choice},'whatsapp.message.interactive',${admin.json({ providerAccountId: channel.provider_account_id, providerEventId: choice, providerMessageId: choice, from: sender, profileName: "Fictional menu", text: "Support", contentType: "interactive", interaction: { id: `oron.menu.${state.generation}.support`, title: "Support" }, replyToProviderMessageId: `synthetic-menu-${conversation}`, occurredAt: new Date().toISOString() })})`;
        for (let pass = 0; pass < 12; pass++) {
          await store.processAvailable();
          await store.drainReplies();
        }
        expect(modelCalls).toBe(1);
        expect(extractionCalls).toBe(0);
        expect(requests[0]?.locale).toBe("en");
        expect(requests[0]?.capabilities).toEqual(["ticket.open"]);
        const reply = await admin<
          { status: string }[]
        >`SELECT status FROM messaging.messages WHERE conversation_id=${conversation}::uuid AND sender_type='agent' AND direction='outbound'`;
        expect(reply).toEqual([{ status: "sent" }]);
        const outbound = (
          await admin<
            { id: string }[]
          >`SELECT job.id FROM ops.jobs job JOIN messaging.outbound_requests request ON request.tenant_id=job.tenant_id AND request.id=job.reference_id WHERE request.conversation_id=${conversation}::uuid AND job.job_type='whatsapp.outbound.send'`
        )[0];
        if (!outbound) throw new Error("Canonical outbound job missing");
        const replayClaim = randomUUID();
        await admin`UPDATE ops.jobs SET status='running',locked_at=clock_timestamp(),locked_by='menu-gate-proof',claim_token=${replayClaim}::uuid,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=${outbound.id}::uuid`;
        const gateJob = {
          id: outbound.id,
          tenant_id: cfg.tenant_id,
          claim_token: replayClaim,
        };
        expect(
          await openingMenuBusinessJobAllowed(
            admin,
            "menu-gate-proof",
            gateJob,
          ),
        ).toBe(true);
        await admin`UPDATE platform.whatsapp_opening_menu_state SET generation=${randomUUID()}::uuid WHERE tenant_id=${cfg.tenant_id}::uuid AND conversation_id=${conversation}::uuid`;
        expect(
          await openingMenuBusinessJobAllowed(
            admin,
            "menu-gate-proof",
            gateJob,
          ),
        ).toBe(false);
        await admin`UPDATE ops.jobs SET status='succeeded',locked_by=NULL,lease_expires_at=NULL WHERE id=${outbound.id}::uuid`;
      } finally {
        await store.close();
        await admin.end({ timeout: 1 });
      }
    },
    30000,
  );
});
