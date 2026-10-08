import type postgres from "postgres";
import {
  parseAgentCapabilities,
  effectiveCapabilities,
} from "./agent-capabilities.js";
import { tenantBusinessContext } from "./tenant-business-context.js";
import { parseCanonicalFlow } from "./cross-channel.js";
import { executablePath } from "./flow-adapters.js";
import {
  composeWhatsAppInstructions,
  whatsAppActionNames,
} from "./whatsapp-instructions.js";

export class EffectivePromptContextRequired extends Error {
  constructor(
    public readonly contextOptions: readonly {
      processId: string;
      label: string;
    }[],
  ) {
    super("effective_prompt_context_required");
  }
}

/** Empty interaction preview; no customer record is loaded by an agent-read route. */
export async function loadEffectivePromptContext(
  sql: postgres.TransactionSql,
  input: {
    profileId: string;
    versionId: string;
    channel: "voice" | "whatsapp";
    processId?: string;
    nodeId?: string;
  },
) {
  const [agent] = await sql<
    {
      tenant_id: string;
      system_prompt: string;
      locale: string;
      channel_configuration: Record<string, unknown>;
      tool_permissions: unknown;
      published_at: Date | null;
      display_name: string;
      support_profile: Record<string, unknown>;
      support_updated_at: Date | null;
    }[]
  >`SELECT v.tenant_id,v.system_prompt,v.locale,v.channel_configuration,v.tool_permissions,v.published_at,
      coalesce(s.display_name,platform.current_tenant_name()) AS display_name,coalesce(s.support_profile,'{}'::jsonb) AS support_profile,
      s.updated_at AS support_updated_at
    FROM agents.agent_profile_versions v
    JOIN agents.agent_profiles p ON p.id=v.agent_profile_id AND p.tenant_id=v.tenant_id
    LEFT JOIN crm.tenant_settings s ON s.tenant_id=v.tenant_id
    WHERE v.tenant_id=platform.current_tenant_id() AND p.id=${input.profileId}::uuid
      AND v.id=${input.versionId}::uuid AND p.archived_at IS NULL
      AND ${input.channel}=ANY(v.channel_capabilities)`;
  if (!agent) return null;
  const routes = await sql<
    {
      id: string;
      name: string;
      agent_profile_version_id: string;
      flow_version_id: string | null;
      definition: unknown;
      revision: number;
      trigger_key: string;
      enabled: boolean;
    }[]
  >`SELECT p.id,p.name,p.agent_profile_version_id,p.flow_version_id,f.definition,p.revision,p.trigger_key,p.enabled
      FROM automation.tenant_processes p
      JOIN agents.agent_profile_versions a ON a.id=p.agent_profile_version_id AND a.tenant_id=p.tenant_id
      LEFT JOIN automation.flow_versions f ON f.id=p.flow_version_id AND f.tenant_id=p.tenant_id
      WHERE p.tenant_id=platform.current_tenant_id() AND a.agent_profile_id=${input.profileId}::uuid
        AND (p.channel=${input.channel} OR p.trigger_key LIKE ${input.channel + ".%"})
      ORDER BY p.priority,p.id`;
  const contextOptions = routes.map((r) => ({
    processId: r.id,
    label: r.name,
  }));
  if (input.processId === undefined && routes.length > 1)
    throw new EffectivePromptContextRequired(contextOptions);
  const route =
    input.processId === undefined
      ? routes[0]
      : routes.find((r) => r.id === input.processId);
  if (input.processId !== undefined && !route) return null;
  let retainedFlowId: string | null = null;
  let retainedFlowVersion: number | null = null;
  if (route?.definition) {
    const path = executablePath(
      parseCanonicalFlow(route.definition),
      input.channel,
    );
    const voiceNodes = path.filter((n) => n.type === "voice.call");
    if (voiceNodes.length > 1)
      throw new EffectivePromptContextRequired(contextOptions);
    const node = voiceNodes[0];
    if (node) {
      retainedFlowId =
        typeof node.configuration?.flowId === "string"
          ? node.configuration.flowId
          : null;
      retainedFlowVersion =
        typeof node.configuration?.flowVersion === "number"
          ? node.configuration.flowVersion
          : null;
      if (
        node.configuration?.agentVersionId &&
        node.configuration.agentVersionId !== input.versionId
      )
        throw new Error("effective_prompt_node_agent_version_mismatch");
    }
  }
  const capabilities = effectiveCapabilities(
    parseAgentCapabilities(agent.tool_permissions),
  );
  const schemaId = agent.channel_configuration.leadFieldSchemaId;
  const schema =
    typeof schemaId === "string"
      ? (
          await sql<
            {
              definition: {
                fields: readonly { key: string; required?: boolean }[];
              };
            }[]
          >`
    SELECT definition FROM crm.lead_field_schemas WHERE tenant_id=platform.current_tenant_id() AND id=${schemaId}::uuid`
        )[0]?.definition
      : undefined;
  const missing = schema?.fields.filter((f) => f.required).map((f) => f.key);
  const actionNames = whatsAppActionNames(capabilities, {
    hasLead: schema !== undefined,
    missingRequiredCount: missing?.length ?? 0,
  });
  const preview = composeWhatsAppInstructions({
    systemPrompt: agent.system_prompt,
    locale: agent.locale,
    capabilities,
    actionNames,
    tenantDisplayName: agent.display_name,
    businessProfileAvailable:
      tenantBusinessContext(agent.support_profile) !== undefined,
    surfaces: { ...(schema ? { leadCollection: true } : {}) },
    ...(missing === undefined ? {} : { missingRequiredFields: missing }),
  });
  return {
    preview,
    contextOptions,
    context: {
      view: "authoring_preview" as const,
      tenantId: agent.tenant_id,
      agentProfileId: input.profileId,
      agentVersionId: input.versionId,
      channel: input.channel,
      processId: route?.id ?? null,
      processRevision: route?.revision ?? null,
      trigger: route?.trigger_key ?? null,
      canonicalFlowVersionId: route?.flow_version_id ?? null,
      retainedFlowId,
      retainedFlowVersion,
      nodeId: input.nodeId ?? null,
      locale: agent.locale,
      tenantProfileRevision: agent.support_updated_at?.toISOString() ?? null,
      state:
        agent.published_at === null
          ? "draft"
          : route?.enabled && route.agent_profile_version_id === input.versionId
            ? "active"
            : "published_pending_activation",
    },
  };
}
