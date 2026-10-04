import { randomUUID } from "node:crypto";
import type postgres from "postgres";

/** A new fictional tenant for each scenario; no external, preconfigured fixture. */
export async function seedOpeningMenuFixture(sql: postgres.Sql) {
  const tenant = randomUUID(),
    user = randomUUID(),
    channel = randomUUID();
  const profile = randomUUID(),
    version = randomUUID(),
    principal = randomUUID();
  const definition = randomUUID(),
    flow = randomUUID();
  const account = `menu-${randomUUID()}`;
  const capabilities = ["lead.write", "ticket.open", "service.intake"];
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
  await sql.begin(async (tx) => {
    await tx`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional opening menu',${tenant},'active')`;
    await tx`INSERT INTO public.users(id,email,status) VALUES(${user}::uuid,${`${user}@example.invalid`},'active')`;
    await tx`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${user}::uuid,'owner')`;
    await tx`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${user},true),set_config('app.current_role','owner',true)`;
    await tx`INSERT INTO crm.tenant_settings(tenant_id,locale,timezone) VALUES(${tenant}::uuid,'en','UTC')`;
    await tx`INSERT INTO messaging.channels(id,tenant_id,kind,provider,provider_account_id,display_address,status,configuration) VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','meta',${account},'Fictional','active',${tx.json({ phoneNumberId: account, wabaId: "fictional", graphApiVersion: "v26.0" })})`;
    await tx`INSERT INTO agents.agent_profiles(id,tenant_id,name,created_by_user_id) VALUES(${profile}::uuid,${tenant}::uuid,'Fictional opening menu',${user}::uuid)`;
    await tx`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,system_prompt,locale,channel_capabilities,tool_permissions,channel_configuration,escalation_configuration,validation_status,created_by_user_id,published_at) VALUES(${version}::uuid,${tenant}::uuid,${profile}::uuid,1,'Help customers safely','en',ARRAY['whatsapp'],${tx.json(capabilities)},'{}','{}','valid',${user}::uuid,clock_timestamp())`;
    await tx`UPDATE platform.tenant_feature_entitlements SET available=true,enabled=true,granted_at=clock_timestamp() WHERE tenant_id=${tenant}::uuid AND feature_key IN ('agents','contacts','whatsapp','leads','tickets')`;
    await tx`INSERT INTO automation.flow_definitions(id,tenant_id,name,channel_capabilities) VALUES(${definition}::uuid,${tenant}::uuid,'Fictional',ARRAY['whatsapp'])`;
    await tx`INSERT INTO automation.flow_versions(id,tenant_id,flow_definition_id,version,schema_version,definition,agent_profile_version_id,validation_status,published_at) VALUES(${flow}::uuid,${tenant}::uuid,${definition}::uuid,1,'1.0',${tx.json({ nodes: [{ id: "crm", type: "crm.update" }] })},${version}::uuid,'valid',clock_timestamp())`;
    await tx`INSERT INTO automation.tenant_processes(tenant_id,name,enabled,trigger_key,channel,agent_profile_version_id,flow_version_id) VALUES(${tenant}::uuid,'Fictional',true,'whatsapp.message','whatsapp',${version}::uuid,${flow}::uuid)`;
    await tx`INSERT INTO platform.tenant_configuration_releases(tenant_id,version,status,configuration,approved_at) VALUES(${tenant}::uuid,2,'published','{}',clock_timestamp())`;
    await tx`INSERT INTO platform.ai_execution_principals(tenant_id,id,role,status,membership_status) VALUES(${tenant}::uuid,${principal}::uuid,'conversation_model_reader_v1','active','active')`;
    await tx`INSERT INTO platform.tenant_ai_execution_bindings(tenant_id,enabled,principal_id) VALUES(${tenant}::uuid,true,${principal}::uuid)`;
    for (const capability of capabilities)
      await tx`INSERT INTO platform.machine_tool_grants(tenant_id,principal_id,agent_version_id,flow_version_id,capability,enabled) VALUES(${tenant}::uuid,${principal}::uuid,${version}::uuid,${flow}::uuid,${capability},true)`;
    await tx`INSERT INTO platform.whatsapp_opening_menu_configuration(tenant_id,channel_id,enabled,agent_version_id,flow_version_id,fallback_language,templates,destinations_verified,services_capabilities,support_capabilities) VALUES(${tenant}::uuid,${channel}::uuid,true,${version}::uuid,${flow}::uuid,'he',${tx.json(templates)},true,ARRAY['lead.write'],ARRAY['ticket.open'])`;
  });
  return {
    tenant_id: tenant,
    channel_id: channel,
    agent_version_id: version,
    flow_version_id: flow,
  };
}
