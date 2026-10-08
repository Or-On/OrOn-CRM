import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { setConversationOwnership } from "@or-on/crm";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";
import {
  WhatsAppAiProviderError,
  type WhatsAppAiDecision,
} from "../src/ai-provider.js";
import { actionReceiptReply } from "../src/ai-grounding.js";
import { modelFailureReply } from "../src/remediation-policy.js";

const url = process.env.MACHINE_TOOLS_TEST_DATABASE_URL;

describe.skipIf(!url)(
  "principal handoff through the actual messaging worker",
  () => {
    it.each([
      "human_requested",
      "non-ticketing",
      "lead-only",
      "unconfirmed-human",
      "unconfirmed-safety",
      "safety",
      "menu-continuity",
      "principal-revoked",
      "grant-revoked",
      "ownership-changed",
      "handoff-cancelled",
      "credential-recheck",
      "altered-acknowledgement",
      "wrong-recipient",
      "source-claim-changed",
      "reopen-changed",
      "release-changed",
      "menu-config-changed",
      "no-tools-disabled-during-model",
      "no-tools-replaced-during-model",
      "provider-failure",
      "provider-failure-revoked",
      "provider-failure-binding-disabled",
    ])(
      "retains and revalidates the exact acknowledgement: %s",
      async (scenario) => {
        if (!url) throw new Error("Owned principal fixture required");
        const target = new URL(url);
        if (
          target.hostname !== "127.0.0.1" ||
          target.port !== "55480" ||
          !/^\/oron_crm_[a-f0-9]{32}$/.test(target.pathname)
        )
          throw new Error("Owned loopback principal database only");
        const admin = postgres(url, { max: 2, prepare: false });
        const tenant = randomUUID(),
          user = randomUUID(),
          channel = randomUUID();
        const contact = randomUUID(),
          profile = randomUUID(),
          agent = randomUUID();
        const conversation = randomUUID(),
          principal = randomUUID();
        const flow = randomUUID(),
          definition = randomUUID();
        const schema = randomUUID();
        const noTools =
          scenario === "non-ticketing" || scenario.startsWith("no-tools-");
        const capabilities = noTools
          ? []
          : [scenario === "lead-only" ? "lead.write" : "ticket.open"];
        const account = `principal-handoff-${randomUUID()}`;
        const sender = `+1555${Date.now().toString().slice(-7)}`;
        const sent: string[] = [];
        let decisions = 0;
        let decision: WhatsAppAiDecision = {
          action: "reply",
          replyCode: "clarify",
          text: "",
        };
        const workerTarget = new URL(url);
        workerTarget.searchParams.set("options", "-c role=platform_messaging");
        const store = createMessagingStore(
          workerTarget.toString(),
          `handoff-${conversation}`,
          {
            simulator: new SimulatorWhatsAppProvider(),
            meta: {
              name: "meta",
              send: async (request) => {
                const acknowledgement =
                  request.delivery.kind === "text" &&
                  request.delivery.text === actionReceiptReply("handoff", "en");
                if (acknowledgement) {
                  if (scenario === "principal-revoked")
                    await admin`UPDATE platform.ai_execution_principals SET status='inactive' WHERE tenant_id=${tenant}::uuid`;
                  if (scenario === "grant-revoked")
                    await admin`UPDATE platform.machine_tool_grants SET enabled=false WHERE tenant_id=${tenant}::uuid`;
                  if (scenario === "ownership-changed")
                    await admin`UPDATE messaging.conversations SET ai_enabled_at=clock_timestamp() WHERE id=${conversation}::uuid`;
                  if (scenario === "handoff-cancelled")
                    await admin`UPDATE automation.handoffs SET status='cancelled' WHERE conversation_id=${conversation}::uuid`;
                  if (scenario === "altered-acknowledgement")
                    await admin`UPDATE messaging.messages SET content_text='Unapproved message' WHERE conversation_id=${conversation}::uuid AND direction='outbound' AND status='queued'`;
                  if (scenario === "wrong-recipient")
                    await admin`UPDATE messaging.outbound_requests SET recipient_address='+15555550199' WHERE conversation_id=${conversation}::uuid AND status='sending'`;
                  if (scenario === "source-claim-changed")
                    await admin`UPDATE ops.jobs SET claim_token=${randomUUID()}::uuid WHERE tenant_id=${tenant}::uuid AND job_type='whatsapp.ai.reply' AND id IN (SELECT source_job_id FROM platform.principal_handoff_authority WHERE tenant_id=${tenant}::uuid)`;
                  if (scenario === "reopen-changed")
                    await admin`UPDATE messaging.conversations SET inbox_reopened_at=clock_timestamp() WHERE id=${conversation}::uuid`;
                  if (scenario === "release-changed")
                    await admin`INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,approved_at) VALUES(${tenant}::uuid,3,'published','{}',clock_timestamp())`;
                  if (scenario === "menu-config-changed")
                    await admin`UPDATE platform.whatsapp_opening_menu_configuration SET fallback_language='he' WHERE tenant_id=${tenant}::uuid`;
                }
                await request.beforeAttempt?.();
                if (acknowledgement && scenario === "credential-recheck") {
                  await admin`UPDATE platform.ai_execution_principals SET status='inactive' WHERE tenant_id=${tenant}::uuid`;
                  // The provider credential read must repeat authority, not reuse the
                  // successful beforeAttempt check from immediately before revocation.
                  await request.accessTokenForAttempt?.();
                }
                if (request.delivery.kind !== "text")
                  throw new Error("Unexpected menu in ongoing session");
                sent.push(request.delivery.text);
                return { messageId: `fictional-${randomUUID()}` };
              },
            },
          },
          undefined,
          {
            realWhatsAppEnabled: true,
            aiProvider: {
              decide: async (_request, _usage, _attempt, beforeAttempt) => {
                await beforeAttempt?.();
                decisions++;
                if (
                  decisions === 2 &&
                  scenario === "no-tools-disabled-during-model"
                )
                  await admin`UPDATE platform.tenant_ai_execution_bindings SET enabled=false WHERE tenant_id=${tenant}::uuid`;
                if (
                  decisions === 2 &&
                  scenario === "no-tools-replaced-during-model"
                ) {
                  const replacement = randomUUID();
                  await admin`INSERT INTO platform.ai_execution_principals(tenant_id,id,role,status,membership_status) VALUES(${tenant}::uuid,${replacement}::uuid,'conversation_model_reader_v1','active','active')`;
                  await admin`UPDATE platform.tenant_ai_execution_bindings SET principal_id=${replacement}::uuid WHERE tenant_id=${tenant}::uuid`;
                }
                if (
                  decisions === 2 &&
                  scenario.startsWith("provider-failure")
                ) {
                  if (scenario === "provider-failure-revoked")
                    await admin`UPDATE platform.ai_execution_principals SET status='inactive' WHERE tenant_id=${tenant}::uuid`;
                  if (scenario === "provider-failure-binding-disabled")
                    await admin`UPDATE platform.tenant_ai_execution_bindings SET enabled=false WHERE tenant_id=${tenant}::uuid`;
                  throw new WhatsAppAiProviderError("ai_invalid_output", false);
                }
                return decision;
              },
            },
          },
        );
        async function inbound(text: string) {
          const message = randomUUID();
          await admin`SELECT ops.accept_whatsapp_inbound(${account},${message},'whatsapp.message.text',${admin.json({ providerAccountId: account, providerEventId: message, providerMessageId: message, from: sender, profileName: "Fictional customer", text, contentType: "text", occurredAt: new Date().toISOString() })})`;
          for (let pass = 0; pass < 8; pass++) {
            await store.processAvailable();
            await store.drainReplies();
          }
        }
        try {
          await admin.begin(async (tx) => {
            await tx`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional principal handoff',${tenant},'active')`;
            await tx`INSERT INTO public.users(id,email,status) VALUES(${user}::uuid,${`${user}@example.invalid`},'active')`;
            await tx`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${user}::uuid,'owner')`;
            await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${user},true),set_config('app.current_role','owner',true)`;
            await tx`INSERT INTO crm.tenant_settings(tenant_id,locale,timezone) VALUES(${tenant}::uuid,'en','UTC')`;
            await tx`UPDATE platform.tenant_feature_entitlements SET available=true,enabled=true,granted_at=clock_timestamp() WHERE tenant_id=${tenant}::uuid AND feature_key IN ('agents','contacts','whatsapp','tickets','leads')`;
            await tx`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,display_address,status,configuration) VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','meta',${account},'Fictional','active',${tx.json({ phoneNumberId: account, wabaId: "fictional", graphApiVersion: "v26.0" })})`;
            await tx`INSERT INTO crm.contacts(id,tenant_id,name,created_by_user_id,whatsapp_consent) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional handoff customer',${user}::uuid,'granted')`;
            await tx`INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,display_value,validation_status,is_primary) VALUES(${tenant}::uuid,${contact}::uuid,'whatsapp',${sender},${sender},'valid',true)`;
            await tx`INSERT INTO agents.agent_profiles(id,tenant_id,name,created_by_user_id) VALUES(${profile}::uuid,${tenant}::uuid,'Fictional principal agent',${user}::uuid)`;
            if (scenario === "lead-only")
              await tx`INSERT INTO crm.lead_field_schemas(id,tenant_id,name,version,definition,created_by_user_id,published_at) VALUES(${schema}::uuid,${tenant}::uuid,'Fictional',1,${tx.json([{ key: "name", label: "Name", type: "text", required: true }])},${user}::uuid,clock_timestamp())`;
            await tx`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,tool_permissions,channel_configuration,escalation_configuration,validation_status,created_by_user_id,published_at,implicit_ticketing) VALUES(${agent}::uuid,${tenant}::uuid,${profile}::uuid,4,'Help customers safely','en',ARRAY['whatsapp'],${tx.json(capabilities)},${tx.json(scenario === "lead-only" ? { leadFieldSchemaId: schema } : {})},'{}','valid',${user}::uuid,clock_timestamp(),false)`;
            await tx`INSERT INTO automation.flow_definitions(id,tenant_id,name,channel_capabilities) VALUES(${definition}::uuid,${tenant}::uuid,'Fictional reviewed',ARRAY['whatsapp'])`;
            await tx`INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,schema_version,definition,agent_profile_version_id,validation_status,published_at) VALUES(${flow}::uuid,${tenant}::uuid,${definition}::uuid,1,'1.0','{"nodes":[{"id":"crm","type":"crm.update"}]}',${agent}::uuid,'valid',clock_timestamp())`;
            await tx`INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,channel,agent_profile_version_id,flow_version_id) VALUES(${tenant}::uuid,'Fictional reviewed',true,'whatsapp.message','whatsapp',${agent}::uuid,${flow}::uuid)`;
            await tx`INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,approved_at) VALUES(${tenant}::uuid,2,'published','{}',clock_timestamp())`;
            await tx`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open','ai',${agent}::uuid,${user}::uuid,clock_timestamp())`;
            await tx`INSERT INTO platform.ai_execution_principals(tenant_id,id,role,status,membership_status) VALUES(${tenant}::uuid,${principal}::uuid,'conversation_model_reader_v1','active','active')`;
            await tx`INSERT INTO platform.tenant_ai_execution_bindings(tenant_id,enabled,principal_id) VALUES(${tenant}::uuid,true,${principal}::uuid)`;
            for (const capability of capabilities)
              await tx`INSERT INTO platform.machine_tool_grants(tenant_id,principal_id,agent_version_id,flow_version_id,capability,enabled) VALUES(${tenant}::uuid,${principal}::uuid,${agent}::uuid,${flow}::uuid,${capability},true)`;
          });
          await inbound("Hello, can you help with my service request?");
          expect(sent).toHaveLength(1);
          expect(decisions).toBe(1);
          if (scenario.startsWith("provider-failure")) {
            await admin`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled) VALUES(${tenant}::uuid,'no_silence',true)`;
            await inbound("My unit is flickering. What can I check?");
            const allowed = scenario === "provider-failure";
            expect(sent).toHaveLength(allowed ? 2 : 1);
            if (allowed) expect(sent[1]).toBe(modelFailureReply("en"));
            const jobs = await admin<
              { status: string; last_error_safe: string | null }[]
            >`SELECT status,last_error_safe FROM ops.jobs WHERE tenant_id=${tenant}::uuid AND job_type='whatsapp.ai.reply' ORDER BY created_at`;
            expect(jobs[1]?.status).toBe(allowed ? "succeeded" : "dead");
            expect(
              await admin`SELECT id FROM automation.handoffs WHERE conversation_id=${conversation}::uuid`,
            ).toHaveLength(0);
            expect(
              await admin`SELECT id FROM crm.tasks WHERE tenant_id=${tenant}::uuid AND contact_id=${contact}::uuid`,
            ).toHaveLength(allowed ? 1 : 0);
            return;
          }
          if (scenario.startsWith("menu-")) {
            const templates = Object.fromEntries(
              ["he", "en"].map((language) => [
                language,
                {
                  name: `fictional_menu_${language}`,
                  language,
                  status: "APPROVED",
                  servicesButtonIndex: 0,
                  supportButtonIndex: 1,
                  servicesButtonText: "Services",
                  supportButtonText: "Support",
                },
              ]),
            );
            await admin.begin(async (tx) => {
              await tx`SELECT set_config('app.current_tenant',${tenant},true)`;
              await tx`INSERT INTO platform.whatsapp_template_policy(tenant_id,enabled) VALUES(${tenant}::uuid,true)`;
              await tx`INSERT INTO platform.whatsapp_opening_menu_configuration(tenant_id,channel_id,enabled,agent_version_id,flow_version_id,fallback_language,templates,destinations_verified,services_capabilities,support_capabilities) VALUES(${tenant}::uuid,${channel}::uuid,true,${agent}::uuid,${flow}::uuid,'en',${tx.json(templates)},true,ARRAY['lead.write'],ARRAY['ticket.open'])`;
            });
          }
          decision = {
            action: "handoff",
            reasonCode: scenario.endsWith("safety")
              ? "safety"
              : "human_requested",
            text: "",
          };
          if (scenario.startsWith("unconfirmed-")) {
            await inbound(
              scenario === "unconfirmed-safety"
                ? "There is a burning smell from the unit."
                : "יש לי תקלה בטלוויזיה, אתה יכול לעזור?",
            );
            await inbound("אתה כאן?");
            expect(sent).toHaveLength(3);
            expect(
              (
                await admin<
                  { ownership_mode: string }[]
                >`SELECT ownership_mode FROM messaging.conversations WHERE id=${conversation}::uuid`
              )[0]?.ownership_mode,
            ).toBe("ai");
            expect(
              await admin`SELECT id FROM automation.handoffs WHERE conversation_id=${conversation}::uuid`,
            ).toHaveLength(0);
            return;
          }
          if (scenario.startsWith("no-tools-")) {
            // Immediate human requests now bypass the model. Keep this race
            // inside a real conversational turn so the provider-side revocation
            // must still be revalidated before any reply is committed or sent.
            decision = { action: "reply", replyCode: "clarify", text: "" };
          }
          await inbound(
            scenario.startsWith("no-tools-")
              ? "My unit is flickering. What can I check?"
              : scenario === "safety"
                ? "There is a burning smell from the unit. Please connect me to a human representative."
                : "Please connect me to a human representative.",
          );
          const jobs = await admin<
            { status: string; last_error_safe: string | null }[]
          >`SELECT status,last_error_safe FROM ops.jobs WHERE tenant_id=${tenant}::uuid AND job_type='whatsapp.ai.reply' ORDER BY created_at`;
          if (scenario.startsWith("no-tools-")) {
            expect(decisions).toBe(2);
            const [binding] = await admin<
              { enabled: boolean; principal_id: string }[]
            >`SELECT enabled,principal_id FROM platform.tenant_ai_execution_bindings WHERE tenant_id=${tenant}::uuid`;
            if (scenario === "no-tools-disabled-during-model")
              expect(binding).toEqual({
                enabled: false,
                principal_id: principal,
              });
            else {
              expect(binding?.enabled).toBe(true);
              expect(binding?.principal_id).not.toBe(principal);
            }
            expect(jobs).toEqual([
              { status: "succeeded", last_error_safe: null },
              {
                status: "dead",
                last_error_safe: "ai_execution_principal_changed",
              },
            ]);
            expect(sent).toHaveLength(1);
            expect(
              await admin`SELECT id FROM automation.handoffs WHERE conversation_id=${conversation}::uuid`,
            ).toHaveLength(0);
            return;
          }
          expect(jobs).toEqual([
            { status: "succeeded", last_error_safe: null },
            { status: "succeeded", last_error_safe: null },
          ]);
          const [state] = await admin<
            { ownership_mode: string }[]
          >`SELECT ownership_mode FROM messaging.conversations WHERE id=${conversation}::uuid`;
          expect(state?.ownership_mode).toBe("human");
          expect(
            await admin`SELECT id FROM automation.handoffs WHERE conversation_id=${conversation}::uuid`,
          ).toHaveLength(1);
          expect(
            await admin`SELECT id FROM support.tickets WHERE source_conversation_id=${conversation}::uuid`,
          ).toHaveLength(noTools || scenario === "lead-only" ? 0 : 1);
          const allowed = [
            "human_requested",
            "non-ticketing",
            "lead-only",
            "safety",
            "menu-continuity",
          ].includes(scenario);
          expect(sent).toHaveLength(allowed ? 2 : 1);
          if (allowed)
            expect(sent[1]).toBe(actionReceiptReply("handoff", "en"));
          // Returning to AI uses the same CRM API as Inbox. A completed human
          // transition must never make the next two independent customer turns mute.
          if (scenario === "human_requested") {
            // The handoff itself was authorized and committed without a model
            // invocation; only the greeting and resumed AI turns invoke it.
            expect(decisions).toBe(1);
            await admin.begin(async (tx) => {
              await tx`SET LOCAL ROLE platform_web`;
              await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${user},true),set_config('app.current_role','owner',true)`;
              expect(
                await setConversationOwnership(
                  tx,
                  conversation,
                  user,
                  "ai",
                  agent,
                ),
              ).toBe(true);
            });
            decision = {
              action: "handoff",
              reasonCode: "insufficient_context",
              text: "",
            };
            await inbound("My television has a problem. Can you help?");
            await inbound("The screen flickers after I turn it on.");
            expect(sent).toHaveLength(4);
            expect(decisions).toBe(3);
            expect(
              (
                await admin<
                  { ownership_mode: string }[]
                >`SELECT ownership_mode FROM messaging.conversations WHERE id=${conversation}::uuid`
              )[0]?.ownership_mode,
            ).toBe("ai");
            expect(
              await admin`SELECT id FROM automation.handoffs WHERE conversation_id=${conversation}::uuid AND status IN ('pending','accepted')`,
            ).toHaveLength(0);
          }
        } finally {
          await store.close();
          await admin.end({ timeout: 1 });
        }
      },
      30000,
    );
  },
);
