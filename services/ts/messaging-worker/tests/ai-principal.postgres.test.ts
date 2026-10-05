import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";
import type { WhatsAppAiProvider } from "../src/ai-provider.js";

const url = process.env.PRINCIPAL_TEST_DATABASE_URL;
describe.skipIf(!url)("owned actual worker principal admission", () => {
  it.each([
    "valid",
    "missing",
    "tools",
    "revokedBeforeAttempt",
    "revokedDuringModel",
    "revokedAfterQueue",
    "bindingDisabledAfterQueue",
    "bindingReplacedAfterQueue",
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
        principal = randomUUID();
      const account = `principal-${randomUUID()}`,
        sender = `+1555${Date.now().toString().slice(-7)}`;
      let physicalCalls = 0,
        sends = 0;
      const provider: WhatsAppAiProvider = {
        decide: async (_request, _usage, _attempt, beforeAttempt) => {
          await beforeAttempt?.();
          physicalCalls++;
          if (scenario === "revokedDuringModel")
            await admin`UPDATE platform.ai_execution_principals SET status='inactive' WHERE tenant_id=${tenant}::uuid`;
          return { action: "reply", text: "Hello! How can I help?" };
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
          await tx`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,tool_permissions,channel_configuration,escalation_configuration,validation_status,created_by_user_id,published_at) VALUES(${version}::uuid,${tenant}::uuid,${profile}::uuid,1,'Help customers safely','en',ARRAY['whatsapp'],${tx.json(scenario === "tools" ? ["ticket.open"] : [])},'{}','{}','valid',${user}::uuid,clock_timestamp())`;
          await tx`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open','ai',${version}::uuid,${user}::uuid,clock_timestamp())`;
          if (scenario !== "missing")
            await tx`INSERT INTO platform.ai_execution_principals(tenant_id,id,role,status,membership_status) VALUES(${tenant}::uuid,${principal}::uuid,'conversation_model_reader_v1','active','active')`;
          await tx`INSERT INTO platform.tenant_ai_execution_bindings(tenant_id,enabled,principal_id) VALUES(${tenant}::uuid,true,${scenario === "missing" ? null : principal}::uuid)`;
        });
        const message = randomUUID();
        await admin`SELECT ops.accept_whatsapp_inbound(${account},${message},'whatsapp.message.text',${admin.json({ providerAccountId: account, providerEventId: message, providerMessageId: message, from: sender, profileName: "Fictional customer", text: "Hi!", contentType: "text", occurredAt: new Date().toISOString() })})`;
        for (let pass = 0; pass < 8; pass++) {
          await store.processAvailable();
          await store.drainReplies();
        }
        expect(physicalCalls).toBe(
          scenario === "valid" ||
            scenario === "revokedDuringModel" ||
            scenario.endsWith("AfterQueue")
            ? 1
            : 0,
        );
        expect(sends).toBe(scenario === "valid" ? 1 : 0);
        expect(
          (
            await admin<
              { allowed: boolean }[]
            >`SELECT has_table_privilege('platform_messaging','platform.outbound_execution_authority','INSERT,UPDATE,DELETE,SELECT') AS allowed`
          )[0]?.allowed,
        ).toBe(false);
        expect(
          (
            await admin<
              { allowed: boolean }[]
            >`SELECT has_function_privilege('platform_web','platform.capture_outbound_execution_authority(uuid,text,uuid,uuid)','EXECUTE') AS allowed`
          )[0]?.allowed,
        ).toBe(false);
        await admin.begin(async (tx) => {
          await tx`SET LOCAL ROLE platform_messaging`;
          await tx`SELECT set_config('app.current_tenant',${tenant},true)`;
          const wrongClaim = await tx<
            { allowed: boolean }[]
          >`SELECT platform.outbound_execution_authorized(${randomUUID()}::uuid,'wrong-worker',${randomUUID()}::uuid) AS allowed`;
          expect(wrongClaim[0]?.allowed).toBe(false);
        });
        const alerts = await admin<
          { reason: string }[]
        >`SELECT reason FROM ops.ai_principal_alerts WHERE tenant_id=${tenant}::uuid`;
        expect(alerts.map((row) => row.reason)).toEqual(
          scenario === "valid" || scenario.endsWith("AfterQueue")
            ? []
            : [
                scenario === "missing"
                  ? "principal_missing"
                  : scenario === "tools"
                    ? "principal_tool_bridge_unavailable"
                    : "principal_inactive",
              ],
        );
        if (scenario.endsWith("AfterQueue")) {
          const retained = await admin<
            { mode: string; principal_id: string }[]
          >`SELECT mode,principal_id FROM platform.outbound_execution_authority WHERE tenant_id=${tenant}::uuid`;
          expect(retained).toEqual([
            { mode: "principal", principal_id: principal },
          ]);
          const jobs = await admin<
            { status: string }[]
          >`SELECT status FROM ops.jobs WHERE tenant_id=${tenant}::uuid AND job_type='whatsapp.outbound.send'`;
          expect(jobs).toEqual([{ status: "dead" }]);
        } else if (scenario !== "valid") {
          const jobs = await admin<
            { status: string; last_error_safe: string }[]
          >`SELECT status,last_error_safe FROM ops.jobs WHERE tenant_id=${tenant}::uuid AND job_type='whatsapp.ai.reply'`;
          expect(jobs).toEqual([
            {
              status: "dead",
              last_error_safe:
                scenario === "tools"
                  ? "machine_tool_denied"
                  : "ai_execution_principal_unavailable",
            },
          ]);
        }
      } finally {
        await store.close();
        await admin.end({ timeout: 1 });
      }
    },
    30000,
  );
});
