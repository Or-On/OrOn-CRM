import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createMessagingStore } from "../src/database.js";
import { SimulatorWhatsAppProvider } from "../src/providers.js";

const url = process.env.MACHINE_TOOLS_TEST_DATABASE_URL;
describe.skipIf(!url)("owned machine service claim authority", () => {
  it.each([
    "valid",
    "triggerPending",
    "revokedDuringExtraction",
    "grantMissing",
    "entitlementMissing",
    "consentRevoked",
    "agentArchived",
    "foreignContactPayload",
    "epochDuringExtraction",
    "principalReplacedDuringExtraction",
    "grantRevokedDuringExtraction",
    "agentArchivedDuringExtraction",
    "flowArchivedDuringExtraction",
    "entitlementRevokedDuringExtraction",
    "configRevokedDuringExtraction",
    "agentRotatedDuringExtraction",
    "grantFlowRotatedDuringExtraction",
  ])(
    "%s",
    async (scenario) => {
      if (!url) throw new Error("owned fixture required");
      const parsed = new URL(url);
      if (
        parsed.hostname !== "127.0.0.1" ||
        parsed.port !== "55480" ||
        !/^\/oron_crm_[a-f0-9]{32}$/.test(parsed.pathname)
      )
        throw new Error("owned loopback fixture only");
      const admin = postgres(url, { max: 2, prepare: false });
      const tenant = randomUUID(),
        user = randomUUID(),
        profile = randomUUID(),
        agent = randomUUID(),
        channel = randomUUID(),
        contact = randomUUID(),
        conversation = randomUUID(),
        principal = randomUUID(),
        definition = randomUUID(),
        flow = randomUUID(),
        message = randomUUID(),
        job = randomUUID();
      const nextAgent = randomUUID(),
        nextFlow = randomUUID(),
        alternateFlow = randomUUID();
      let calls = 0;
      const workerUrl = new URL(url);
      workerUrl.searchParams.set("options", "-c role=platform_messaging");
      const simulator = new SimulatorWhatsAppProvider();
      const store = createMessagingStore(
        workerUrl.toString(),
        `machine-service-${job}`,
        { simulator, meta: simulator },
        undefined,
        {
          fieldServiceProvider: {
            providerName: "fictional",
            modelName: "fake-no-http",
            extractIntake: async () => {
              calls++;
              if (scenario === "revokedDuringExtraction")
                await admin`UPDATE platform.ai_execution_principals SET status='inactive' WHERE tenant_id=${tenant}::uuid`;
              if (scenario === "epochDuringExtraction")
                await admin`UPDATE messaging.conversations SET ownership_mode='human' WHERE id=${conversation}::uuid`;
              if (scenario === "principalReplacedDuringExtraction") {
                const replacement = randomUUID();
                await admin`INSERT INTO platform.ai_execution_principals(tenant_id,id,role,status,membership_status) VALUES(${tenant}::uuid,${replacement}::uuid,'conversation_model_reader_v1','active','active')`;
                await admin`INSERT INTO platform.machine_tool_grants(tenant_id,principal_id,agent_version_id,flow_version_id,capability,enabled) VALUES(${tenant}::uuid,${replacement}::uuid,${agent}::uuid,${flow}::uuid,'service.intake',true)`;
                await admin`UPDATE platform.tenant_ai_execution_bindings SET principal_id=${replacement}::uuid WHERE tenant_id=${tenant}::uuid`;
              }
              if (scenario === "grantRevokedDuringExtraction")
                await admin`UPDATE platform.machine_tool_grants SET enabled=false WHERE tenant_id=${tenant}::uuid`;
              if (scenario === "agentArchivedDuringExtraction")
                await admin`UPDATE agents.agent_profiles SET archived_at=clock_timestamp() WHERE id=${profile}::uuid`;
              if (scenario === "flowArchivedDuringExtraction")
                await admin`UPDATE automation.flow_definitions SET archived_at=clock_timestamp() WHERE id=${definition}::uuid`;
              if (scenario === "entitlementRevokedDuringExtraction")
                await admin`UPDATE platform.tenant_feature_entitlements SET available=false WHERE tenant_id=${tenant}::uuid AND feature_key='field_service'`;
              if (scenario === "configRevokedDuringExtraction")
                await admin`UPDATE service.tenant_configuration SET whatsapp_intake_enabled=false WHERE tenant_id=${tenant}::uuid`;
              if (scenario === "grantFlowRotatedDuringExtraction")
                await admin`UPDATE platform.machine_tool_grants SET flow_version_id=${alternateFlow}::uuid WHERE tenant_id=${tenant}::uuid AND agent_version_id=${agent}::uuid`;
              if (scenario === "agentRotatedDuringExtraction")
                await admin`UPDATE messaging.conversations SET ai_agent_profile_version_id=${nextAgent}::uuid WHERE id=${conversation}::uuid`;
              return {
                serviceIntent: true,
                confirmed: false,
                confidence: 1,
                fields: {},
              };
            },
            extractProductLabel: () => Promise.reject(new Error("not used")),
            summarizeEvidence: () => Promise.reject(new Error("not used")),
          },
        },
      );
      try {
        await admin.begin(async (tx) => {
          await tx`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional machine service',${tenant},'active')`;
          await tx`INSERT INTO public.users(id,email,status) VALUES(${user}::uuid,${`${user}@example.invalid`},'active')`;
          await tx`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${user}::uuid,'owner')`;
          await tx`SELECT set_config('app.current_tenant',${tenant},true)`;
          await tx`UPDATE platform.tenant_feature_entitlements SET available=true,enabled=true,granted_at=clock_timestamp() WHERE tenant_id=${tenant}::uuid AND feature_key IN ('agents','contacts','whatsapp','field_service','tickets')`;
          await tx`INSERT INTO platform.tenant_feature_entitlements(tenant_id,feature_key,available,enabled,granted_at) VALUES(${tenant}::uuid,'field_service',true,true,clock_timestamp()) ON CONFLICT(tenant_id,feature_key) DO UPDATE SET available=true,enabled=true,granted_at=clock_timestamp()`;
          await tx`INSERT INTO service.tenant_configuration(tenant_id,enabled,whatsapp_intake_enabled) VALUES(${tenant}::uuid,true,true) ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,whatsapp_intake_enabled=true`;
          await tx`INSERT INTO agents.agent_profiles(id,tenant_id,name,created_by_user_id) VALUES(${profile}::uuid,${tenant}::uuid,'Fictional machine service',${user}::uuid)`;
          await tx`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,tool_permissions,channel_configuration,escalation_configuration,validation_status,created_by_user_id,published_at) VALUES(${agent}::uuid,${tenant}::uuid,${profile}::uuid,1,'Fictional','en',ARRAY['whatsapp'],'["service.intake"]','{}','{}','valid',${user}::uuid,clock_timestamp())`;
          await tx`INSERT INTO automation.flow_definitions(id,tenant_id,name,channel_capabilities) VALUES(${definition}::uuid,${tenant}::uuid,'Fictional reviewed',ARRAY['whatsapp'])`;
          await tx`INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,schema_version,definition,agent_profile_version_id,validation_status,published_at) VALUES(${flow}::uuid,${tenant}::uuid,${definition}::uuid,1,'1.0','{"nodes":[{"id":"crm","type":"crm.update"}]}',${agent}::uuid,'valid',clock_timestamp())`;
          await tx`INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,channel,agent_profile_version_id,flow_version_id) VALUES(${tenant}::uuid,'Fictional reviewed',true,'whatsapp.message','whatsapp',${agent}::uuid,${flow}::uuid)`;
          await tx`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,tool_permissions,channel_configuration,escalation_configuration,validation_status,created_by_user_id,published_at) VALUES(${nextAgent}::uuid,${tenant}::uuid,${profile}::uuid,2,'Fictional next','en',ARRAY['whatsapp'],'["service.intake"]','{}','{}','valid',${user}::uuid,clock_timestamp())`;
          await tx`INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,schema_version,definition,agent_profile_version_id,validation_status,published_at) VALUES(${nextFlow}::uuid,${tenant}::uuid,${definition}::uuid,2,'1.0','{"nodes":[{"id":"crm","type":"crm.update"}]}',${nextAgent}::uuid,'valid',clock_timestamp())`;
          await tx`INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,channel,agent_profile_version_id,flow_version_id,priority) VALUES(${tenant}::uuid,'Fictional reviewed next',true,'whatsapp.message','whatsapp',${nextAgent}::uuid,${nextFlow}::uuid,101)`;
          await tx`INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,schema_version,definition,agent_profile_version_id,validation_status,published_at) VALUES(${alternateFlow}::uuid,${tenant}::uuid,${definition}::uuid,3,'1.0','{"nodes":[{"id":"crm","type":"crm.update"}]}',${agent}::uuid,'valid',clock_timestamp())`;
          await tx`INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,channel,agent_profile_version_id,flow_version_id,priority) VALUES(${tenant}::uuid,'Fictional reviewed alternate',true,'whatsapp.message','whatsapp',${agent}::uuid,${alternateFlow}::uuid,102)`;
          await tx`INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,approved_at) VALUES(${tenant}::uuid,2,'published','{}',clock_timestamp())`;
          await tx`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,display_address,status) VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','simulator',${channel},'Fictional','active')`;
          await tx`INSERT INTO crm.contacts(id,tenant_id,name,created_by_user_id) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional',${user}::uuid)`;
          await tx`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status,ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at) VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open','ai',${agent}::uuid,${user}::uuid,clock_timestamp())`;
          await tx`INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,provider,provider_message_id,content_type,content_text,status) VALUES(${message}::uuid,${tenant}::uuid,${conversation}::uuid,'inbound','contact','simulator',${message},'text','Fictional service request',${scenario === "triggerPending" ? "pending" : "received"})`;
          await tx`INSERT INTO platform.ai_execution_principals(tenant_id,id,role,status,membership_status) VALUES(${tenant}::uuid,${principal}::uuid,'conversation_model_reader_v1','active','active')`;
          await tx`INSERT INTO platform.tenant_ai_execution_bindings(tenant_id,enabled,principal_id) VALUES(${tenant}::uuid,true,${principal}::uuid)`;
          await tx`INSERT INTO platform.machine_tool_grants(tenant_id,principal_id,agent_version_id,flow_version_id,capability,enabled) VALUES(${tenant}::uuid,${principal}::uuid,${agent}::uuid,${flow}::uuid,'service.intake',true)`;
          await tx`INSERT INTO platform.machine_tool_grants(tenant_id,principal_id,agent_version_id,flow_version_id,capability,enabled) VALUES(${tenant}::uuid,${principal}::uuid,${nextAgent}::uuid,${nextFlow}::uuid,'service.intake',true)`;
          await tx`INSERT INTO ops.jobs(id,tenant_id,queue,job_type,reference_type,reference_id,payload,status,max_attempts) VALUES(${job}::uuid,${tenant}::uuid,'messaging','field_service.intake.extract','message',${message}::uuid,${tx.json({ conversationId: conversation, contactId: contact, triggerMessageId: message })},'queued',1)`;
        });
        if (scenario === "grantMissing")
          await admin`UPDATE platform.machine_tool_grants SET enabled=false WHERE tenant_id=${tenant}::uuid`;
        if (scenario === "entitlementMissing")
          await admin`UPDATE platform.tenant_feature_entitlements SET available=false WHERE tenant_id=${tenant}::uuid AND feature_key='field_service'`;
        if (scenario === "consentRevoked")
          await admin`UPDATE public.users SET status='inactive' WHERE id=${user}::uuid`;
        if (scenario === "agentArchived")
          await admin`UPDATE agents.agent_profiles SET archived_at=clock_timestamp() WHERE id=${profile}::uuid`;
        if (scenario === "foreignContactPayload")
          await admin`UPDATE ops.jobs SET payload=jsonb_set(payload,'{contactId}',to_jsonb(${randomUUID()}::text)) WHERE id=${job}::uuid`;
        await store.processAvailable();
        const outcome = await admin<
          { status: string; last_error_safe: string | null }[]
        >`SELECT status,last_error_safe FROM ops.jobs WHERE id=${job}::uuid`;
        expect(calls).toBe(
          scenario === "valid" || scenario.endsWith("DuringExtraction") ? 1 : 0,
        );
        expect(outcome[0]?.status).toBe(
          scenario === "valid" ? "succeeded" : "dead",
        );
        const drafts = await admin<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM service.intake_drafts WHERE tenant_id=${tenant}::uuid`;
        expect(drafts[0]?.count).toBe(scenario === "valid" ? 1 : 0);
        const receipts = await admin<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM platform.machine_tool_receipts WHERE tenant_id=${tenant}::uuid AND capability='service.intake'`;
        expect(receipts[0]?.count).toBe(scenario === "valid" ? 1 : 0);
      } finally {
        await store.close();
        await admin.end({ timeout: 1 });
      }
    },
    30000,
  );
});
