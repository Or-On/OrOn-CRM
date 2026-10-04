import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";
import type { WhatsAppAiProvider } from "../src/ai-provider.js";

const url = process.env.MACHINE_TOOLS_TEST_DATABASE_URL;
describe.skipIf(!url)("owned actual machine lead worker", () => {
  it.each([
    "valid",
    "grantMissing",
    "revokedDuringModel",
    "ticket",
    "ticketRevokedDuringModel",
    "ticketRevokedAfterQueue",
    "ticketFlowRotatedAfterQueue",
  ])(
    "%s principal controls physical model work",
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
        channel = randomUUID(),
        contact = randomUUID(),
        profile = randomUUID(),
        version = randomUUID(),
        conversation = randomUUID(),
        principal = randomUUID(),
        schema = randomUUID(),
        flow = randomUUID(),
        definition = randomUUID();
      const account = `principal-${randomUUID()}`,
        sender = `+1555${Date.now().toString().slice(-7)}`;
      let physicalCalls = 0,
        sends = 0;
      const provider: WhatsAppAiProvider = {
        decide: async (_request, _usage, _attempt, beforeAttempt) => {
          await beforeAttempt?.();
          physicalCalls++;
          if (
            scenario === "revokedDuringModel" ||
            scenario === "ticketRevokedDuringModel"
          )
            await admin`UPDATE platform.machine_tool_grants SET enabled=false WHERE tenant_id=${tenant}::uuid`;
          if (scenario.startsWith("ticket"))
            return {
              action: "ticket_open",
              subject: "Fictional support issue",
            };
          if (physicalCalls === 1)
            return {
              action: "lead_save",
              observations: [
                {
                  key: "name",
                  state: "known",
                  value: "Fictional",
                  confirmed: true,
                },
              ],
            };
          if (physicalCalls === 2)
            return { action: "lead_finalize", summary: "Fictional enquiry" };
          if (physicalCalls === 3)
            return { action: "lead_follow_up", note: "Fictional follow up" };
          return { action: "reply", text: "Thank you" };
        },
      };
      const workerTarget = new URL(url);
      workerTarget.searchParams.set("options", "-c role=platform_messaging");
      const store = createMessagingStore(
        workerTarget.toString(),
        `principal-${scenario}`,
        {
          simulator: new SimulatorWhatsAppProvider(),
          meta: {
            name: "meta",
            send: async (request) => {
              if (scenario === "revokedAfterQueue")
                await admin`UPDATE platform.ai_execution_principals SET status='inactive' WHERE tenant_id=${tenant}::uuid`;
              if (scenario === "bindingDisabledAfterQueue")
                await admin`UPDATE platform.tenant_ai_execution_bindings SET enabled=false WHERE tenant_id=${tenant}::uuid`;
              if (scenario === "bindingReplacedAfterQueue") {
                const replacement = randomUUID();
                await admin`INSERT INTO platform.ai_execution_principals(tenant_id,id,role,status,membership_status) VALUES(${tenant}::uuid,${replacement}::uuid,'conversation_model_reader_v1','active','active')`;
                await admin`UPDATE platform.tenant_ai_execution_bindings SET principal_id=${replacement}::uuid WHERE tenant_id=${tenant}::uuid`;
              }
              if (scenario === "ticketRevokedAfterQueue")
                await admin`UPDATE platform.machine_tool_grants SET enabled=false WHERE tenant_id=${tenant}::uuid`;
              if (scenario === "ticketFlowRotatedAfterQueue") {
                const nextFlow = randomUUID();
                await admin`INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,schema_version,definition,agent_profile_version_id,validation_status,published_at) SELECT ${nextFlow}::uuid,tenant_id,flow_definition_id,2,schema_version,definition,agent_profile_version_id,validation_status,clock_timestamp() FROM automation.flow_versions WHERE id=${flow}::uuid`;
                await admin`INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,channel,agent_profile_version_id,flow_version_id,priority) VALUES(${tenant}::uuid,'Fictional next approved',true,'whatsapp.message','whatsapp',${version}::uuid,${nextFlow}::uuid,101)`;
                await admin`UPDATE platform.machine_tool_grants SET flow_version_id=${nextFlow}::uuid WHERE tenant_id=${tenant}::uuid`;
              }
              await request.beforeAttempt?.();
              sends++;
              return { messageId: `fixture-${randomUUID()}` };
            },
          },
        },
        undefined,
        {
          aiProvider: provider,
          realWhatsAppEnabled: true,
          beforeModelAttempt: async () => {
            if (scenario === "revokedBeforeAttempt")
              await admin`UPDATE platform.ai_execution_principals SET status='inactive' WHERE tenant_id=${tenant}::uuid`;
          },
        },
      );
      try {
        await admin.begin(async (tx) => {
          await tx`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional principal worker',${tenant},'active')`;
          await tx`INSERT INTO public.users(id,email,status) VALUES(${user}::uuid,${`${user}@example.invalid`},'active')`;
          await tx`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${user}::uuid,'owner')`;
          await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${user},true),set_config('app.current_role','owner',true)`;
          await tx`INSERT INTO crm.tenant_settings(tenant_id,locale,timezone) VALUES(${tenant}::uuid,'en','UTC')`;
          await tx`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,display_address,status,configuration) VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','meta',${account},'Fictional','active',${tx.json({ phoneNumberId: account, wabaId: "fictional", graphApiVersion: "v26.0" })})`;
          await tx`INSERT INTO crm.contacts(id,tenant_id,name,created_by_user_id,whatsapp_consent) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional principal customer',${user}::uuid,'granted')`;
          await tx`INSERT INTO crm.contact_channel_identities(tenant_id,contact_id,channel,normalized_value,display_value,validation_status,is_primary) VALUES(${tenant}::uuid,${contact}::uuid,'whatsapp',${sender},${sender},'valid',true)`;
          await tx`INSERT INTO agents.agent_profiles(id,tenant_id,name,created_by_user_id) VALUES(${profile}::uuid,${tenant}::uuid,'Fictional principal agent',${user}::uuid)`;
          await tx`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,tool_permissions,channel_configuration,escalation_configuration,validation_status,created_by_user_id,published_at) VALUES(${version}::uuid,${tenant}::uuid,${profile}::uuid,1,'Help customers safely','en',ARRAY['whatsapp'],${tx.json(["lead.write", "lead.finalize", "lead.follow_up", "ticket.open"])},${tx.json({ leadFieldSchemaId: schema })},'{}','valid',${user}::uuid,clock_timestamp())`;
          await tx`UPDATE platform.tenant_feature_entitlements SET available=true,enabled=true,granted_at=clock_timestamp() WHERE tenant_id=${tenant}::uuid AND feature_key IN ('agents','contacts','whatsapp','leads','tickets')`;
          await tx`INSERT INTO crm.lead_field_schemas(id,tenant_id,name,version,definition,created_by_user_id,published_at) VALUES(${schema}::uuid,${tenant}::uuid,'Fictional',1,${tx.json([{ key: "name", label: "Name", type: "text", required: true }])},${user}::uuid,clock_timestamp())`;
          await tx`INSERT INTO automation.flow_definitions(id,tenant_id,name,channel_capabilities) VALUES(${definition}::uuid,${tenant}::uuid,'Fictional',ARRAY['whatsapp'])`;
          await tx`INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,schema_version,definition,agent_profile_version_id,validation_status,published_at) VALUES(${flow}::uuid,${tenant}::uuid,${definition}::uuid,1,'1.0',${tx.json({ nodes: [{ id: "crm", type: "crm.update" }] })},${version}::uuid,'valid',clock_timestamp())`;
          await tx`INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,channel,agent_profile_version_id,flow_version_id) VALUES(${tenant}::uuid,'Fictional',true,'whatsapp.message','whatsapp',${version}::uuid,${flow}::uuid)`;
          await tx`INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,approved_at) VALUES(${tenant}::uuid,2,'published','{}',clock_timestamp())`;
          await tx`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open','ai',${version}::uuid,${user}::uuid,clock_timestamp())`;
          if (scenario !== "missing")
            await tx`INSERT INTO platform.ai_execution_principals(tenant_id,id,role,status,membership_status) VALUES(${tenant}::uuid,${principal}::uuid,'conversation_model_reader_v1','active','active')`;
          await tx`INSERT INTO platform.tenant_ai_execution_bindings(tenant_id,enabled,principal_id) VALUES(${tenant}::uuid,true,${scenario === "missing" ? null : principal}::uuid)`;
          for (const capability of scenario === "grantMissing"
            ? []
            : ["lead.write", "lead.finalize", "lead.follow_up", "ticket.open"])
            await tx`INSERT INTO platform.machine_tool_grants(tenant_id,principal_id,agent_version_id,flow_version_id,capability,enabled) VALUES(${tenant}::uuid,${principal}::uuid,${version}::uuid,${flow}::uuid,${capability},true)`;
        });
        for (let turn = 0; turn < (scenario === "valid" ? 3 : 1); turn++) {
          const message = randomUUID();
          await admin`SELECT ops.accept_whatsapp_inbound(${account},${message},'whatsapp.message.text',${admin.json({ providerAccountId: account, providerEventId: message, providerMessageId: message, from: sender, profileName: "Fictional customer", text: "Hi!", contentType: "text", occurredAt: new Date().toISOString() })})`;
          for (let pass = 0; pass < 8; pass++) {
            await store.processAvailable();
            await store.drainReplies();
          }
        }
        if (scenario === "valid")
          expect(physicalCalls).toBeGreaterThanOrEqual(3);
        else expect(physicalCalls).toBe(scenario === "grantMissing" ? 0 : 1);
        const receipts = await admin<
          { capability: string; resource_id: string }[]
        >`SELECT capability,resource_id FROM platform.machine_tool_receipts WHERE tenant_id=${tenant}::uuid ORDER BY capability`;
        if (scenario === "ticket") {
          expect(receipts.some((row) => row.capability === "ticket.open")).toBe(
            true,
          );
          expect(sends).toBe(1);
        } else if (
          scenario === "ticketRevokedAfterQueue" ||
          scenario === "ticketFlowRotatedAfterQueue"
        ) {
          expect(receipts.some((row) => row.capability === "ticket.open")).toBe(
            true,
          );
          expect(sends).toBe(0);
        } else if (scenario === "valid") {
          expect(receipts.some((row) => row.capability === "lead.write")).toBe(
            true,
          );
          expect(
            receipts.some((row) => row.capability === "lead.finalize"),
          ).toBe(true);
          expect(
            receipts.some((row) => row.capability === "lead.follow_up"),
          ).toBe(true);
        } else {
          if (scenario === "ticketRevokedDuringModel")
            expect(
              receipts.some((row) => row.capability === "ticket.open"),
            ).toBe(false);
          expect(
            receipts.some(
              (row) =>
                row.capability === "lead.finalize" ||
                row.capability === "lead.follow_up",
            ),
          ).toBe(false);
          const values = await admin<
            { count: string }[]
          >`SELECT count(*)::text AS count FROM crm.lead_field_values WHERE tenant_id=${tenant}::uuid`;
          expect(values[0]?.count).toBe("0");
        }
        const audit = await admin<
          { actor_user_id: string | null }[]
        >`SELECT actor_user_id FROM audit.records WHERE tenant_id=${tenant}::uuid AND actor_service='machine-principal'`;
        if (scenario === "valid") expect(audit.length).toBeGreaterThan(0);
        expect(audit.every((row) => row.actor_user_id === null)).toBe(true);
      } finally {
        await store.close();
        await admin.end({ timeout: 1 });
      }
    },
    30000,
  );
});
