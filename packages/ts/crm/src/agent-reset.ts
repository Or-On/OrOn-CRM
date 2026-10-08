import { createHash } from "node:crypto";
import type postgres from "postgres";
import { agentRuntimePolicy } from "@or-on/config";
import {
  createAgentProfileRevision,
  createCanonicalFlowDraft,
  publishAgentProfile,
  publishCanonicalFlow,
  rebindAgentConversations,
} from "./cross-channel.js";
import { createLeadFieldSchema } from "./leads.js";
import { parseAgentCapabilities } from "./agent-capabilities.js";
import {
  getTenantConfigurationState,
  saveTenantConfigurationDraft,
  transitionTenantConfiguration,
} from "./tenant-configuration.js";
import type { JsonValue } from "./types.js";
import { assertKnowledgeManager } from "./knowledge.js";
import {
  defaultAgentQuality,
  parseAgentQuality,
  qualityObject,
} from "./agent-quality.js";

/** Every identifier comes from a reviewed inventory, never a tenant slug. */
export interface AgentResetPlan {
  readonly tenantId: string;
  readonly operationId: string;
  readonly profileId: string;
  readonly expectedAgentVersionId: string;
  readonly expectedReleaseId: string | null;
  readonly expectedReleaseRevision: number | null;
  readonly expectedCatalogSha256: string;
  readonly voiceFlowId: string;
  readonly voiceFlowVersion: number;
  readonly expectedVoiceSpecSha256: string;
  readonly name: string;
  readonly systemPrompt: string;
  readonly fields: unknown;
  readonly capabilities: readonly string[];
  readonly maxResponseTokens: number;
  readonly phoneRegion?: "IL";
  readonly reviewedModelConfigurationId?: string;
}

export function resetDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Read-only inventory is also the rollback data: restore by a new reviewed release. */
export async function inspectAgentReset(
  sql: postgres.TransactionSql,
  plan: AgentResetPlan,
) {
  await assertKnowledgeManager(sql);
  const tenant = await sql<{ id: string }[]>`
    SELECT platform.current_tenant_id() AS id WHERE platform.current_tenant_id()=${plan.tenantId}::uuid`;
  if (!tenant[0]) throw new TypeError("Resolved reset tenant mismatch");
  const settings = await sql<{ support_profile: Record<string, JsonValue> }[]>`
    SELECT support_profile FROM crm.tenant_settings WHERE tenant_id=platform.current_tenant_id()`;
  const profile = settings[0]?.support_profile ?? {};
  const catalog = {
    businessDescription: profile.businessDescription ?? null,
    productsAndServices: profile.productsAndServices ?? [],
  };
  const agents = await sql<
    {
      id: string;
      version: number;
      model_configuration_id: string | null;
      system_prompt: string;
      channel_configuration: JsonValue;
      knowledge_configuration: JsonValue;
    }[]
  >`
    SELECT id,version,model_configuration_id,system_prompt,channel_configuration,knowledge_configuration
    FROM agents.agent_profile_versions WHERE agent_profile_id=${plan.profileId}::uuid ORDER BY version DESC LIMIT 1`;
  const retained = await sql<{ spec: JsonValue }[]>`
    SELECT spec FROM public.flows WHERE tenant_id=platform.current_tenant_id()
    AND flow_id=${plan.voiceFlowId}::uuid AND version=${plan.voiceFlowVersion}`;
  const configuration = await getTenantConfigurationState(sql);
  const owners = await sql<
    { mode: string; version: string | null; count: number }[]
  >`
    SELECT ownership_mode AS mode,ai_agent_profile_version_id::text AS version,count(*)::int
    FROM messaging.conversations GROUP BY ownership_mode,ai_agent_profile_version_id`;
  const calls = await sql<
    { count: number }[]
  >`SELECT count(*)::int FROM public.sessions WHERE status='started'`;
  const greetings = await sql<
    { channel_id: string; enabled: boolean }[]
  >`SELECT channel_id,enabled FROM messaging.whatsapp_auto_greetings`;
  const menus = await sql<
    {
      channel_id: string;
      enabled: boolean;
      agent_version_id: string;
      flow_version_id: string;
    }[]
  >`
    SELECT channel_id,enabled,agent_version_id,flow_version_id FROM platform.whatsapp_opening_menu_configuration`;
  return {
    tenant: tenant[0],
    catalog,
    catalogSha256: resetDigest(catalog),
    agent: agents[0] ?? null,
    voiceSpecSha256: retained[0] ? resetDigest(retained[0].spec) : null,
    configuration,
    owners,
    activeCalls: calls[0]?.count ?? 0,
    greetings,
    menus,
  };
}

/** Run inside one application-role transaction. Replays recover the committed IDs. */
export async function prepareAgentReset(
  sql: postgres.TransactionSql,
  actor: string,
  plan: AgentResetPlan,
) {
  await assertKnowledgeManager(sql);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(platform.current_tenant_id()::text || ':agent-reset',0))`;
  const digest = resetDigest(plan);
  const prior = await sql<{ metadata: Record<string, JsonValue> }[]>`
    SELECT metadata FROM audit.records WHERE action='agent.reset.prepared' AND target_id=${plan.operationId}::uuid`;
  if (prior[0]) {
    if (prior[0].metadata.planDigest !== digest)
      throw new TypeError("Reset operation content changed");
    return prior[0].metadata;
  }
  const before = await inspectAgentReset(sql, plan);
  if (
    before.agent?.id !== plan.expectedAgentVersionId ||
    (before.configuration.active?.id ?? null) !== plan.expectedReleaseId ||
    (before.configuration.active?.revision ?? null) !==
      plan.expectedReleaseRevision ||
    before.configuration.draft
  )
    throw new TypeError("Reset revisions changed; review a fresh inventory");
  if (
    before.catalogSha256 !== plan.expectedCatalogSha256 ||
    !Array.isArray(before.catalog.productsAndServices) ||
    before.catalog.productsAndServices.length === 0
  )
    throw new TypeError("An unchanged approved service catalog is required");
  if (before.voiceSpecSha256 !== plan.expectedVoiceSpecSha256)
    throw new TypeError(
      "Reviewed retained voice flow is unavailable or changed",
    );
  // Custom routes require a separate reviewed model revision. Never silently
  // replace one with deployment credentials or overwrite its published history.
  if (
    before.agent.model_configuration_id !== null &&
    !plan.reviewedModelConfigurationId
  )
    throw new TypeError(
      "Explicit tenant model binding requires reviewed model migration",
    );
  if (
    before.greetings.some((row) => row.enabled) ||
    before.menus.some((row) => row.enabled)
  )
    throw new TypeError(
      "Conflicting opening menu or automatic greeting must be reviewed first",
    );
  const schema = await createLeadFieldSchema(sql, actor, {
    name: plan.name,
    definition: { schemaVersion: "1.0", fields: plan.fields },
    completionPolicy: "service_discovery_v1",
    publish: true,
  });
  const revision = await createAgentProfileRevision(
    sql,
    actor,
    plan.profileId,
    {
      baseVersionId: plan.expectedAgentVersionId,
      systemPrompt: plan.systemPrompt,
      locale: "he",
      channels: ["voice", "whatsapp"],
      toolPermissions: parseAgentCapabilities(plan.capabilities),
      leadFieldSchemaId: schema.id,
      ...(plan.phoneRegion === undefined
        ? {}
        : { phoneRegion: plan.phoneRegion }),
    },
  );
  if (!revision) throw new TypeError("Reset profile unavailable");
  const priorQuality = qualityObject(
    before.agent.channel_configuration,
  ).quality;
  const quality = parseAgentQuality(priorQuality ?? defaultAgentQuality);
  const reviewedQuality = parseAgentQuality({
    ...quality,
    language: "he",
    agentGrammar: agentRuntimePolicy.voice.agentGrammar,
    callerAddressDefault: "unknown",
    speakingStyle: "concise",
    voiceId: agentRuntimePolicy.voice.voice,
    budgets: { ...quality.budgets, maxResponseTokens: plan.maxResponseTokens },
  });
  await sql`UPDATE agents.agent_profile_versions SET channel_configuration=channel_configuration ||
    ${sql.json({ quality: JSON.parse(JSON.stringify(reviewedQuality)) as JsonValue })}
    WHERE id=${revision.versionId}::uuid AND published_at IS NULL`;
  if (plan.reviewedModelConfigurationId) {
    const model = await sql<
      { id: string }[]
    >`SELECT id FROM agents.model_configurations
      WHERE id=${plan.reviewedModelConfigurationId}::uuid AND tenant_id=platform.current_tenant_id()
        AND is_enabled AND provider='gemini' AND model='gemini-3.5-flash-lite'
        AND (NOT settings ? 'maxTokens' OR
          (jsonb_typeof(settings->'maxTokens')='number' AND (settings->>'maxTokens')::numeric>=${plan.maxResponseTokens}))
        AND settings->>'fallbackModel'='gemini-3.1-flash-lite' FOR SHARE`;
    if (model.length !== 1)
      throw new TypeError("Reviewed model migration is unavailable");
    await sql`UPDATE agents.agent_profile_versions SET model_configuration_id=${plan.reviewedModelConfigurationId}::uuid
      WHERE id=${revision.versionId}::uuid AND published_at IS NULL`;
  }
  const flowId = await createCanonicalFlowDraft(
    sql,
    actor,
    `${plan.name} · v${String(revision.version)}`,
    revision.versionId,
    {
      schemaVersion: "1.0",
      channels: ["voice", "whatsapp"],
      nodes: [
        { id: "start", type: "start" },
        {
          id: "call",
          type: "voice.call",
          configuration: {
            flowId: plan.voiceFlowId,
            flowVersion: plan.voiceFlowVersion,
            agentVersionId: revision.versionId,
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        {
          id: "voice-start",
          source: "start",
          target: "call",
          channels: ["voice"],
        },
        { id: "voice-end", source: "call", target: "end", channels: ["voice"] },
        {
          id: "whatsapp-conversation",
          source: "start",
          target: "end",
          channels: ["whatsapp"],
        },
      ],
    },
  );
  const report = {
    planDigest: digest,
    before,
    agentVersionId: revision.versionId,
    flowDefinitionId: flowId,
    schemaId: schema.id,
    publication: "pending_golden_evaluation",
    activation: "not_applied",
  };
  await sql`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
    VALUES(platform.current_tenant_id(),${actor}::uuid,'agent.reset.prepared','agent_reset',${plan.operationId}::uuid,${sql.json(JSON.parse(JSON.stringify(report)) as JsonValue)})`;
  return report;
}

/** Publication remains gated by the existing golden evidence function. */
export async function publishPreparedAgentReset(
  sql: postgres.TransactionSql,
  actor: string,
  profileId: string,
  versionId: string,
  flowDefinitionId: string,
): Promise<void> {
  await assertKnowledgeManager(sql);
  const published = await sql<
    { id: string }[]
  >`SELECT flow.id FROM automation.flow_versions flow
    JOIN agents.agent_profile_versions agent ON agent.id=flow.agent_profile_version_id AND agent.tenant_id=flow.tenant_id
    WHERE flow.flow_definition_id=${flowDefinitionId}::uuid AND flow.published_at IS NOT NULL
      AND agent.id=${versionId}::uuid AND agent.agent_profile_id=${profileId}::uuid AND agent.published_at IS NOT NULL`;
  if (published.length === 1) return;
  if (!(await publishAgentProfile(sql, actor, profileId, versionId)))
    throw new TypeError("Agent publication failed");
  if (!(await publishCanonicalFlow(sql, actor, flowDefinitionId)))
    throw new TypeError("Flow publication failed");
}

/** Only explicit reviewed triggers move. Other tenant operations remain in the snapshot. */
export async function activatePreparedAgentReset(
  sql: postgres.TransactionSql,
  actor: string,
  plan: AgentResetPlan,
  versionId: string,
  flowVersionId: string,
  rebindExistingAi: boolean,
) {
  await assertKnowledgeManager(sql);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(platform.current_tenant_id()::text || ':agent-reset',0))`;
  const activationDigest = resetDigest({
    plan,
    versionId,
    flowVersionId,
    rebindExistingAi,
  });
  const prior = await sql<
    { metadata: Record<string, JsonValue> }[]
  >`SELECT metadata FROM audit.records
    WHERE action='agent.reset.activated' AND target_id=${plan.operationId}::uuid`;
  if (prior[0]) {
    if (prior[0].metadata.activationDigest !== activationDigest)
      throw new TypeError("Activation operation content changed");
    return prior[0].metadata;
  }
  const prepared = await sql<
    { metadata: Record<string, JsonValue> }[]
  >`SELECT metadata FROM audit.records
    WHERE action='agent.reset.prepared' AND target_id=${plan.operationId}::uuid`;
  if (
    prepared[0]?.metadata.planDigest !== resetDigest(plan) ||
    prepared[0].metadata.agentVersionId !== versionId
  )
    throw new TypeError("Prepared reset does not match activation");
  const preparedFlowId = prepared[0].metadata.flowDefinitionId;
  if (typeof preparedFlowId !== "string")
    throw new TypeError("Prepared flow identity is invalid");
  const flows = await sql<
    { id: string }[]
  >`SELECT id FROM automation.flow_versions
    WHERE id=${flowVersionId}::uuid AND flow_definition_id=${preparedFlowId}::uuid
      AND agent_profile_version_id=${versionId}::uuid AND published_at IS NOT NULL`;
  if (flows.length !== 1)
    throw new TypeError("Prepared published flow required");
  const inventory = await inspectAgentReset(sql, plan);
  if (
    inventory.catalogSha256 !== plan.expectedCatalogSha256 ||
    inventory.voiceSpecSha256 !== plan.expectedVoiceSpecSha256 ||
    inventory.greetings.some((row) => row.enabled) ||
    inventory.menus.some((row) => row.enabled)
  )
    throw new TypeError("Activation context changed; review again");
  const state = await getTenantConfigurationState(sql);
  if (
    state.draft ||
    (state.active?.id ?? null) !== plan.expectedReleaseId ||
    (state.active?.revision ?? null) !== plan.expectedReleaseRevision
  )
    throw new TypeError("Configuration changed before activation");
  const before = state.active?.configuration ?? state.initialConfiguration;
  const triggers = [
    "whatsapp.new_conversation",
    "whatsapp.message",
    "voice.inbound",
    "voice.outbound_assignment",
  ] as const;
  const configuration = {
    ...before,
    processes: [
      ...before.processes.filter(
        (p) => !(triggers as readonly string[]).includes(p.trigger),
      ),
      ...triggers.map((trigger) => ({
        name: `${plan.name}: ${trigger}`,
        enabled: true,
        trigger,
        channel: trigger.startsWith("voice.")
          ? ("voice" as const)
          : ("whatsapp" as const),
        businessObject: "lead" as const,
        agentProfileVersionId: versionId,
        flowVersionId,
        priority: 10,
      })),
    ],
  };
  await saveTenantConfigurationDraft(
    sql,
    configuration,
    null,
    `${plan.operationId}:save`,
  );
  let next = await getTenantConfigurationState(sql);
  if (!next.draft) throw new TypeError("Configuration draft missing");
  await transitionTenantConfiguration(
    sql,
    "submit",
    next.draft.revision,
    "Reviewed shared agent reset",
    `${plan.operationId}:submit`,
  );
  next = await getTenantConfigurationState(sql);
  if (!next.draft) throw new TypeError("Submitted configuration missing");
  await transitionTenantConfiguration(
    sql,
    "approve",
    next.draft.revision,
    "Reviewed shared agent reset",
    `${plan.operationId}:approve`,
  );
  const rebound = rebindExistingAi
    ? await rebindAgentConversations(sql, actor, plan.profileId, versionId)
    : null;
  const report = {
    activationDigest,
    state: await getTenantConfigurationState(sql),
    rebound,
    rollbackConfiguration: before,
  };
  await sql`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
    VALUES(platform.current_tenant_id(),${actor}::uuid,'agent.reset.activated','agent_reset',${plan.operationId}::uuid,${sql.json(JSON.parse(JSON.stringify(report)) as JsonValue)})`;
  return report;
}

/** Restore the captured configuration as a new release; never rewrite history or chats. */
export async function rollbackPreparedAgentReset(
  sql: postgres.TransactionSql,
  actor: string,
  plan: AgentResetPlan,
  expectedActiveReleaseId: string,
  rollbackOperationId: string,
) {
  await assertKnowledgeManager(sql);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(platform.current_tenant_id()::text || ':agent-reset',0))`;
  if (
    plan.tenantId !==
    (await sql`SELECT platform.current_tenant_id() AS id`)[0]?.id
  )
    throw new TypeError("Resolved rollback tenant mismatch");
  const digest = resetDigest({
    plan,
    expectedActiveReleaseId,
    rollbackOperationId,
  });
  const [prior] = await sql<{ metadata: Record<string, JsonValue> }[]>`
    SELECT metadata FROM audit.records WHERE action='agent.reset.rolled_back' AND target_id=${rollbackOperationId}::uuid`;
  if (prior) {
    if (prior.metadata.rollbackDigest !== digest)
      throw new TypeError("Rollback operation content changed");
    return prior.metadata;
  }
  const [activation] = await sql<{ metadata: Record<string, JsonValue> }[]>`
    SELECT metadata FROM audit.records WHERE action='agent.reset.activated' AND target_id=${plan.operationId}::uuid`;
  const [preparation] = await sql<{ metadata: Record<string, JsonValue> }[]>`
    SELECT metadata FROM audit.records WHERE action='agent.reset.prepared' AND target_id=${plan.operationId}::uuid`;
  if (!activation || preparation?.metadata.planDigest !== resetDigest(plan))
    throw new TypeError("Matching activated reset required for rollback");
  const state = await getTenantConfigurationState(sql);
  if (state.draft || state.active?.id !== expectedActiveReleaseId)
    throw new TypeError("Configuration changed before rollback; review again");
  await saveTenantConfigurationDraft(
    sql,
    activation.metadata.rollbackConfiguration,
    null,
    `${rollbackOperationId}:save`,
  );
  for (const action of ["submit", "approve"] as const) {
    const next = await getTenantConfigurationState(sql);
    if (!next.draft) throw new TypeError("Rollback draft missing");
    await transitionTenantConfiguration(
      sql,
      action,
      next.draft.revision,
      "Restore reviewed pre-reset configuration",
      `${rollbackOperationId}:${action}`,
    );
  }
  const report = {
    rollbackDigest: digest,
    state: await getTenantConfigurationState(sql),
    existingConversationsRebound: false,
    activeCallsRebound: false,
  };
  await sql`INSERT INTO audit.records(tenant_id,actor_user_id,action,target_type,target_id,metadata)
    VALUES(platform.current_tenant_id(),${actor}::uuid,'agent.reset.rolled_back','agent_reset',${rollbackOperationId}::uuid,${sql.json(JSON.parse(JSON.stringify(report)) as JsonValue)})`;
  return report;
}
